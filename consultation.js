// consultation.js
// Drives the on-demand teleconsultation room: auth check → load
// consultation → let the practitioner start it / patient join it →
// mount the Daily.co Prebuilt call inside #video-container.

// ══════════════════════════════════════════════════════
//  CONFIG — same project as the rest of the Ascle app
// ══════════════════════════════════════════════════════
const SUPABASE_URL  = 'YOUR_PROJECT.supabase.co';   // ← paste from Supabase Dashboard → Project Settings → API
const SUPABASE_ANON = 'YOUR_ANON_PUBLIC_KEY';        // ← paste from Supabase Dashboard → Project Settings → API

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

let CURRENT_USER = null;
let consultation = null;
let callFrame = null;
let realtimeChannel = null;

const $ = (id) => document.getElementById(id);

function getConsultationId() {
  const params = new URLSearchParams(window.location.search);
  return params.get('id');
}

function initials(name) {
  return (name || '?')
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function showError(msg) {
  const el = $('inline-error');
  el.textContent = msg;
  el.style.display = 'block';
}
function clearError() {
  const el = $('inline-error');
  el.style.display = 'none';
  el.textContent = '';
}

// ── Boot ────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const consultationId = getConsultationId();
  if (!consultationId) {
    renderFatal('No consultation specified', 'This link is missing a consultation id.');
    return;
  }

  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    // Not logged in — bounce back to the main app to authenticate,
    // then return here afterwards.
    window.location.href = `/?redirect=${encodeURIComponent(window.location.href)}`;
    return;
  }
  CURRENT_USER = session.user;

  await loadConsultation(consultationId);
  subscribeToConsultation(consultationId);
});

// ── Load consultation + participant profiles ─────────────
async function loadConsultation(id) {
  const { data, error } = await sb
    .from('consultations')
    .select(`
      id, status, scheduled_at, daily_room_url, ended_at,
      patient_id, practitioner_id,
      patient:profiles!consultations_patient_id_fkey ( full_name ),
      practitioner:profiles!consultations_practitioner_id_fkey ( full_name, role )
    `)
    .eq('id', id)
    .single();

  if (error || !data) {
    renderFatal('Consultation not found', "We couldn't load this consultation. It may have been cancelled or the link is invalid.");
    return;
  }

  consultation = data;
  renderState();
}

// ── Live updates: if the other participant starts/ends the call,
//    this tab's UI reacts without a manual refresh.
// ──────────────────────────────────────────────────────────
function subscribeToConsultation(id) {
  realtimeChannel = sb
    .channel(`consultation-${id}`)
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'consultations', filter: `id=eq.${id}` },
      (payload) => {
        consultation = { ...consultation, ...payload.new };
        renderState();
      }
    )
    .subscribe();
}

// ── Rendering ─────────────────────────────────────────────
function isPractitioner() {
  return consultation && CURRENT_USER && consultation.practitioner_id === CURRENT_USER.id;
}

function renderFatal(title, sub) {
  $('status-label').textContent = 'Error';
  $('vp-title').textContent = title;
  $('vp-sub').textContent = sub;
  $('action-row').innerHTML = `<a class="btn btn-outline" href="/">Return to dashboard</a>`;
}

function renderState() {
  if (!consultation) return;
  clearError();

  const pill = $('status-pill');
  pill.className = `status-pill status-${consultation.status}`;
  $('status-label').textContent = consultation.status[0].toUpperCase() + consultation.status.slice(1);

  const when = consultation.scheduled_at
    ? new Date(consultation.scheduled_at).toLocaleString('en-NG', {
        weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
      })
    : '—';
  $('consult-meta').textContent = `📅 ${when}`;

  const patientName = consultation.patient?.full_name || 'Patient';
  const practitionerName = consultation.practitioner?.full_name || 'Awaiting assignment';
  const practitionerRole = consultation.practitioner?.role === 'nurse' ? 'Nurse' : 'Doctor';

  $('patient-name').textContent = patientName;
  $('patient-av').textContent = initials(patientName);
  $('practitioner-name').textContent = practitionerName;
  $('practitioner-role').textContent = practitionerRole;
  $('practitioner-av').textContent = initials(practitionerName);

  const actionRow = $('action-row');
  const vpTitle = $('vp-title');
  const vpSub = $('vp-sub');

  // If a call is already mounted, don't re-render the placeholder over it.
  if (callFrame) return;

  switch (consultation.status) {
    case 'scheduled':
      if (isPractitioner()) {
        vpTitle.textContent = 'Ready to see your patient';
        vpSub.textContent = `Starting the call creates a secure, private video room for you and ${patientName}.`;
        actionRow.innerHTML = `<button class="btn btn-primary" id="start-btn">Start Consultation →</button>`;
        $('start-btn').addEventListener('click', () => joinCall());
      } else {
        vpTitle.textContent = 'Waiting for your practitioner';
        vpSub.textContent = `${practitionerName} hasn't started the consultation yet. This page will update automatically.`;
        actionRow.innerHTML = `<button class="btn btn-outline" disabled>Waiting…</button>`;
      }
      break;

    case 'active':
      vpTitle.textContent = 'Consultation is live';
      vpSub.textContent = 'Join when you\'re ready. Please make sure you\'re somewhere private and well-lit.';
      actionRow.innerHTML = `<button class="btn btn-primary" id="join-btn">Join Call →</button>`;
      $('join-btn').addEventListener('click', () => joinCall());
      break;

    case 'completed':
      vpTitle.textContent = 'Consultation ended';
      vpSub.textContent = 'This session has finished. Your practitioner\'s notes will appear in your records shortly.';
      actionRow.innerHTML = `<a class="btn btn-outline" href="/?page=appointments">View appointments</a>`;
      break;

    case 'cancelled':
      vpTitle.textContent = 'Consultation cancelled';
      vpSub.textContent = 'This consultation was cancelled.';
      actionRow.innerHTML = `<a class="btn btn-outline" href="/">Return to dashboard</a>`;
      break;
  }
}

// ── Join / start the call ────────────────────────────────
async function joinCall() {
  clearError();
  const actionRow = $('action-row');
  actionRow.innerHTML = `<button class="btn btn-primary" disabled>Connecting…</button>`;

  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) throw new Error('Your session expired — please sign in again.');

    const resp = await fetch('/.netlify/functions/create-room', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ consultation_id: consultation.id }),
    });

    const result = await resp.json();
    if (!resp.ok) throw new Error(result.error || 'Could not connect to the video room');

    mountCall(result.room_url, result.token);
  } catch (err) {
    showError(err.message || 'Something went wrong connecting to the call.');
    renderState(); // restore the button since callFrame is still null
  }
}

function mountCall(roomUrl, token) {
  $('video-placeholder').style.display = 'none';
  $('action-row').innerHTML = `<button class="btn btn-danger" id="leave-btn">Leave Call</button>`;

  callFrame = DailyIframe.createFrame($('video-container'), {
    showLeaveButton: false, // we render our own "Leave Call" control below the frame
    iframeStyle: {
      width: '100%',
      height: '100%',
      border: '0',
    },
  });

  callFrame
    .join({ url: roomUrl, token })
    .catch((err) => {
      showError('Failed to join the video call: ' + (err?.message || 'unknown error'));
    });

  callFrame.on('left-meeting', handleLeftMeeting);
  callFrame.on('error', (e) => showError('Call error: ' + (e?.errorMsg || 'connection issue')));

  $('leave-btn').addEventListener('click', () => callFrame.leave());
}

async function handleLeftMeeting() {
  if (callFrame) {
    callFrame.destroy();
    callFrame = null;
  }
  $('video-placeholder').style.display = 'flex';

  // Only the practitioner ending the call marks the consultation
  // 'completed'; a patient leaving early can still be rejoined.
  if (isPractitioner() && consultation.status === 'active') {
    const { error } = await sb
      .from('consultations')
      .update({ status: 'completed', ended_at: new Date().toISOString() })
      .eq('id', consultation.id);
    if (!error) {
      consultation.status = 'completed';
      consultation.ended_at = new Date().toISOString();
    }
  }
  renderState();
}

window.addEventListener('beforeunload', () => {
  if (realtimeChannel) sb.removeChannel(realtimeChannel);
});
