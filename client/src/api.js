// Tiny API client.
async function req(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status}`);
  return data;
}

export const api = {
  get: (url) => req('GET', url),
  post: (url, body) => req('POST', url, body ?? {}),
  patch: (url, body) => req('PATCH', url, body),
  del: (url) => req('DELETE', url),
};
