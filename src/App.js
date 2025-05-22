import { useEffect, useState } from 'react';
import axios from 'axios';
import './App.css';

const clientId = '74ac1a3a-4927-4fa7-8c06-b5cba15473c0';
const redirectUri = 'http://localhost:3000';
const scope = 'launch openid fhirUser patient/*.read user/Observation.read user/Observation.write user/Patient.read';

const defaultLaunchUrl = "http://localhost:3000/?iss=https://fhir-ehr-code.cerner.com/r4/ec2458f2-1e24-41c8-b71b-0e701af7583d&launch=59792dc4-fc9c-4046-ada6-b9e63240b979";

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
  const url = new URL(`https://authorization.cerner.com/tenants/${tenantId}/protocols/oauth2/profiles/smart-v1/personas/provider/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', scope);
  url.searchParams.set('state', Math.random().toString(36).substring(2));
  url.searchParams.set('aud', iss);
  url.searchParams.set('launch', launch);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
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

  const response = await axios.post(tokenUrl, payload, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });

  return response.data;
}

export default function App() {
  const [patient, setPatient] = useState(null);
  const [observations, setObservations] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    const url = new URL(window.location.href);
    const code = url.searchParams.get('code');
    const iss = url.searchParams.get('iss');
    const launch = url.searchParams.get('launch');

    if (code) {
      const codeVerifier = localStorage.getItem('code_verifier');
      const storedIss = localStorage.getItem('iss');

      makeTokenRequest(code, codeVerifier, storedIss)
        .then((data) => {
          const accessToken = data.access_token;
          const patientId = data.patient;

          localStorage.setItem('access_token', accessToken);
          localStorage.setItem('patient', patientId);
          localStorage.setItem('iss', storedIss);

          window.history.replaceState({}, '', redirectUri);
          fetchPatient(storedIss, accessToken, patientId);
          fetchObservations(storedIss, accessToken, patientId);
        })
        .catch((err) => {
          console.error(err);
          setError('Token exchange failed');
        });
    } else if (iss && launch) {
      const codeVerifier = Math.random().toString(36).repeat(5).substring(0, 128);
      localStorage.setItem('code_verifier', codeVerifier);
      localStorage.setItem('iss', iss);

      sha256(codeVerifier).then((hash) => {
        const codeChallenge = base64URLEncode(hash);
        const authUrl = constructAuthUrl(iss, launch, codeChallenge);
        window.location.href = authUrl;
      });
    } else {
      const token = localStorage.getItem('access_token');
      const patientId = localStorage.getItem('patient');
      const storedIss = localStorage.getItem('iss');
      if (token && storedIss && patientId) {
        fetchPatient(storedIss, token, patientId);
        fetchObservations(storedIss, token, patientId);
      }
    }
  }, []);

  function fetchPatient(iss, token, patientId) {
    axios
      .get(`${iss}/Patient/${patientId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      .then((res) => setPatient(res.data))
      .catch((err) => {
        console.error(err);
        setError('FHIR Patient read failed');
      });
  }

  function fetchObservations(iss, token, patientId) {
    axios
      .get(`${iss}/Observation?patient=${patientId}&_sort=-date&_count=5`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      .then((res) => setObservations(res.data.entry || []))
      .catch((err) => {
        console.error('Observation fetch failed', err);
      });
  }

  return (
    <div className="container">
      <div className="card">
        <h1>Trigonal SMART on FHIR (R4)</h1>
        {error && <p className="error">❌ {error}</p>}
        {patient ? (
          <div className="patient-info">
            <h2>{patient.name?.[0]?.given?.[0]} {patient.name?.[0]?.family}</h2>
            <p><strong>Gender:</strong> {patient.gender}</p>
            <p><strong>DOB:</strong> {patient.birthDate}</p>
            <p><strong>Status:</strong> {patient.active ? 'Active' : 'Inactive'}</p>
            <p><strong>Address:</strong> {patient.address?.[0]?.text}</p>
          </div>
        ) : (
          <div className="loading">
            <p>🔄 No active session</p>
            <button onClick={() => window.location.href = defaultLaunchUrl} className="login">
              🔐 Login with Cerner
            </button>
          </div>
        )}

        {observations.length > 0 && (
          <div className="observation-section">
            <h3>Recent Observations</h3>
            <ul>
              {observations.map((entry, idx) => {
                const obs = entry.resource;
                return (
                  <li key={idx}>
                    <strong>{obs.code?.text || 'Unknown'}</strong>: {obs.valueQuantity?.value} {obs.valueQuantity?.unit}
                    <br />
                    <small>{new Date(obs.effectiveDateTime).toLocaleString()}</small>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <button onClick={() => { localStorage.clear(); window.location.reload(); }} className="logout">Logout</button>
      </div>
    </div>
  );
}
