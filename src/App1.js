import { useEffect, useState } from 'react';
import axios from 'axios';

const clientId = '74ac1a3a-4927-4fa7-8c06-b5cba15473c0';
const redirectUri = 'http://localhost:3000';
const scope =
  'launch openid fhirUser patient/*.read user/Observation.read user/Observation.write user/Patient.read';

function base64URLEncode(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function sha256(plain) {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  return await crypto.subtle.digest('SHA-256', data);
}

function getTenantId(iss) {
  const parts = iss.split('/');
  return parts[parts.length - 1];
}

function constructAuthUrl(iss, launch, codeChallenge) {
  const tenantId = getTenantId(iss);
  const url = new URL(
    `https://authorization.cerner.com/tenants/${tenantId}/protocols/oauth2/profiles/smart-v1/personas/provider/authorize`
  );

  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', scope);
  url.searchParams.set('state', Math.random().toString(36).substring(2));
  url.searchParams.set('aud', iss);
  url.searchParams.set('launch', launch);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');

  console.log("🔗 Constructed Cerner Auth URL:", url.href);
  return url.href;
}

async function makeTokenRequest(code, codeVerifier, iss) {
  const tenantId = getTenantId(iss);
  const tokenUrl = `https://authorization.cerner.com/tenants/${tenantId}/hosts/fhir-ehr-code.cerner.com/protocols/oauth2/profiles/smart-v1/token`;

  const payload = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
  });

  console.log("📤 Token Exchange Payload:", Object.fromEntries(payload));
  console.log("🔁 Token Endpoint:", tokenUrl);

  const response = await axios.post(tokenUrl, payload, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });

  console.log("✅ Token Response:", response.data);
  return response.data;
}

export default function App() {
  const [patient, setPatient] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const url = new URL(window.location.href);
    const code = url.searchParams.get('code');
    const iss = url.searchParams.get('iss');
    const launch = url.searchParams.get('launch');

    console.log("🧭 URL Params:", { code, iss, launch });

    if (code) {
      // Returned from Cerner with ?code=...
      const codeVerifier = localStorage.getItem('code_verifier');
      const storedIss = localStorage.getItem('iss');

      if (!codeVerifier || !storedIss) {
        console.error("❌ Missing code_verifier or iss in localStorage");
        setError("Missing verification or issuer data.");
        return;
      }

      makeTokenRequest(code, codeVerifier, storedIss)
        .then((data) => {
          const accessToken = data.access_token;
          const patientId = data.patient;

          console.log("🔐 Access Token:", accessToken);
          console.log("👤 Patient ID:", patientId);

          localStorage.setItem('access_token', accessToken);
          localStorage.setItem('patient', patientId);
          localStorage.setItem('iss', storedIss);

          window.history.replaceState({}, '', redirectUri);
          fetchPatient(storedIss, accessToken, patientId);
        })
        .catch((err) => {
          console.error("❌ Token exchange error:", err);
          setError('Token exchange failed');
        });
    } else if (iss && launch) {
      // Launched from EHR
      const codeVerifier = Math.random().toString(36).repeat(5).substring(0, 128);
      localStorage.setItem('code_verifier', codeVerifier);
      localStorage.setItem('iss', iss);

      sha256(codeVerifier).then((hash) => {
        const codeChallenge = base64URLEncode(hash);
        const authUrl = constructAuthUrl(iss, launch, codeChallenge);
        window.location.href = authUrl;
      });
    } else {
      // Already have token?
      const token = localStorage.getItem('access_token');
      const patientId = localStorage.getItem('patient');
      const storedIss = localStorage.getItem('iss');

      console.log("🔁 Resuming session from localStorage:", { token, patientId, storedIss });

      if (token && storedIss && patientId) {
        fetchPatient(storedIss, token, patientId);
      }
    }
  }, []);

  function fetchPatient(iss, token, patientId) {
    console.log("📡 Fetching Patient:", `${iss}/Patient/${patientId}`);
    axios
      .get(`${iss}/Patient/${patientId}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })
      .then((res) => {
        console.log("✅ Patient Data:", res.data);
        setPatient(res.data);
      })
      .catch((err) => {
        console.error("❌ FHIR Patient fetch failed:", err);
        setError('FHIR Patient read failed');
      });
  }

  return (
    <div style={{ padding: '2rem', fontFamily: 'Arial' }}>
      <h2>Trigonal SMART on FHIR App (R4)</h2>
      {error && <p style={{ color: 'red' }}>❌ {error}</p>}
      {patient ? (
        <pre>{JSON.stringify(patient, null, 2)}</pre>
      ) : (
        <p>🔄 Waiting for login or patient data...</p>
      )}
    </div>
  );
}
