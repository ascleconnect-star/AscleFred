// netlify/functions/create-room.js
//
// POST /.netlify/functions/create-room
// Headers: Authorization: Bearer <supabase access_token>
// Body:    { "consultation_id": "uuid" }
//
// Response: { "room_url": "https://ascle.daily.co/xxxxx", "token": "eyJ...", "status": "active" }
//
// Security model:
//  - The caller's Supabase JWT is verified server-side (never trust a
//    client-sent user id).
//  - The consultation row is fetched with the SERVICE ROLE key (bypasses
//    RLS) so we can authoritatively check the caller is one of the two
//    participants — the same check RLS enforces for reads, done again
//    here because this function's writes are privileged.
//  - Daily rooms are created PRIVATE. Nobody can join with just the
//    room URL; each participant is issued a short-lived, room-scoped
//    meeting token. The practitioner's token carries owner privileges
//    (can eject participants, end the room for everyone); the
//    patient's does not.
//  - The room is idempotent per consultation (name derived from the
//    consultation id), so both participants calling this endpoint —
//    the practitioner "starting" the call and the patient "joining"
//    it — converge on the same room instead of creating duplicates.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DAILY_API_KEY = process.env.DAILY_API_KEY;
const DAILY_DOMAIN = process.env.DAILY_DOMAIN; // e.g. "ascle" for ascle.daily.co — optional, only used for logging/validation

const ROOM_LIFETIME_SECONDS = 2 * 60 * 60; // 2 hours from room creation
const MAX_PARTICIPANTS = 2;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !DAILY_API_KEY) {
    console.error('Missing required environment variables');
    return json(500, { error: 'Server misconfigured' });
  }

  // ── Parse body ────────────────────────────────────────────────
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }
  const consultationId = payload.consultation_id;
  if (!consultationId || typeof consultationId !== 'string') {
    return json(400, { error: 'consultation_id is required' });
  }

  // ── Auth: verify the caller's access token ──────────────────────
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const accessToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!accessToken) {
    return json(401, { error: 'Missing bearer token' });
  }

  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(accessToken);
  if (userError || !userData?.user) {
    return json(401, { error: 'Invalid or expired session' });
  }
  const callerId = userData.user.id;

  // ── Load the consultation (service role bypasses RLS) ───────────
  const { data: consultation, error: fetchError } = await supabaseAdmin
    .from('consultations')
    .select('id, patient_id, practitioner_id, status, scheduled_at, daily_room_url, daily_room_name')
    .eq('id', consultationId)
    .single();

  if (fetchError || !consultation) {
    return json(404, { error: 'Consultation not found' });
  }

  const isPatient = callerId === consultation.patient_id;
  const isPractitioner = callerId === consultation.practitioner_id;
  if (!isPatient && !isPractitioner) {
    return json(403, { error: 'You are not a participant in this consultation' });
  }

  if (consultation.status === 'completed' || consultation.status === 'cancelled') {
    return json(409, { error: `Consultation is ${consultation.status}; cannot join a call` });
  }

  if (!isPractitioner && consultation.status === 'scheduled') {
    // Patients can't spin up the room themselves — only the
    // practitioner starting the session should create it.
    return json(409, { error: 'Waiting for the practitioner to start the consultation' });
  }

  // ── Look up caller's display name for the meeting token ─────────
  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('full_name')
    .eq('id', callerId)
    .single();
  const userName = profile?.full_name || (isPractitioner ? 'Practitioner' : 'Patient');

  const roomName = consultation.daily_room_name || `ascle-consult-${consultation.id}`;
  let roomUrl = consultation.daily_room_url;

  // ── Create the Daily room if it doesn't exist yet ────────────────
  if (!roomUrl) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const createRoomResp = await fetch('https://api.daily.co/v1/rooms', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${DAILY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: roomName,
        privacy: 'private',
        properties: {
          exp: nowSeconds + ROOM_LIFETIME_SECONDS,
          eject_at_room_exp: true,
          max_participants: MAX_PARTICIPANTS,
          enable_prejoin_ui: true,
          enable_chat: true,
          enable_screenshare: true,
          enable_knocking: false,
          start_video_off: false,
          start_audio_off: false,
        },
      }),
    });

    if (createRoomResp.status === 400) {
      // Most likely "room already exists" from a concurrent request —
      // fetch the existing room instead of failing.
      const existingResp = await fetch(`https://api.daily.co/v1/rooms/${roomName}`, {
        headers: { Authorization: `Bearer ${DAILY_API_KEY}` },
      });
      if (!existingResp.ok) {
        const errText = await existingResp.text();
        console.error('Daily room lookup failed:', errText);
        return json(502, { error: 'Failed to create or locate video room' });
      }
      const existingRoom = await existingResp.json();
      roomUrl = existingRoom.url;
    } else if (!createRoomResp.ok) {
      const errText = await createRoomResp.text();
      console.error('Daily room creation failed:', errText);
      return json(502, { error: 'Failed to create video room' });
    } else {
      const newRoom = await createRoomResp.json();
      roomUrl = newRoom.url;
    }

    // Persist the room + flip status to 'active' (service role bypasses RLS
    // and the protect_daily_room_columns trigger, by design).
    const { error: updateError } = await supabaseAdmin
      .from('consultations')
      .update({
        daily_room_url: roomUrl,
        daily_room_name: roomName,
        status: 'active',
      })
      .eq('id', consultation.id);

    if (updateError) {
      console.error('Failed to persist room on consultation:', updateError.message);
      return json(500, { error: 'Room created but failed to save to consultation' });
    }
  }

  // ── Mint a short-lived meeting token for THIS caller ─────────────
  const tokenResp = await fetch('https://api.daily.co/v1/meeting-tokens', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${DAILY_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      properties: {
        room_name: roomName,
        user_name: userName,
        user_id: callerId,
        is_owner: isPractitioner,
        exp: Math.floor(Date.now() / 1000) + ROOM_LIFETIME_SECONDS,
      },
    }),
  });

  if (!tokenResp.ok) {
    const errText = await tokenResp.text();
    console.error('Daily meeting token creation failed:', errText);
    return json(502, { error: 'Failed to authorize video session' });
  }
  const tokenData = await tokenResp.json();

  return json(200, {
    room_url: roomUrl,
    token: tokenData.token,
    status: 'active',
    is_owner: isPractitioner,
  });
};
