/* Thin wrapper over the preload bridge. In a plain browser (development only) it falls back to demo data. */
let mock = null;

export async function initApi() {
  if (!window.classicmail && __WITH_MOCK__) {
    mock = (await import('./mockApi.js')).default;
  }
}

export const isDemo = () => Boolean(mock);

export async function call(name, ...args) {
  let res;
  if (window.classicmail) res = await window.classicmail.invoke(name, ...args);
  else if (mock) res = await mock.invoke(name, ...args);
  else throw new Error('ClassicMail is not connected to its backend.');
  if (!res || !res.ok) throw new Error((res && res.error) || 'Something went wrong.');
  return res.data;
}

export function on(event, callback) {
  if (window.classicmail) return window.classicmail.on(event, callback);
  if (mock) return mock.on(event, callback);
  return () => {};
}
