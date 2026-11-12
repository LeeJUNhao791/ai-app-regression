import { readFileSync } from 'node:fs';
import { defaultProfile, validDevice } from './profile.mjs';

const responseFields = ['id', 'text', 'status', 'device', 'category'];
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;

function loadMapping(path) {
  const invalid = (field, message) => {
    throw new Error(`Backend map "${path}", field ${field}: ${message}`);
  };
  let map;
  try {
    map = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path)));
  } catch {
    invalid('root', 'expected a readable UTF-8 JSON file.');
  }
  if (!isObject(map)) invalid('root', 'expected an object.');
  const route = (value) => typeof value === 'string' && /^\/(?!\/)/.test(value) && !/[?#\\\s]/.test(value);
  if (!route(map.create_path) || /[{}]/.test(map.create_path)) {
    invalid('create_path', 'expected a path starting with a single / and no placeholders.');
  }
  if (!route(map.lookup_path) || !map.lookup_path.includes('{id}') ||
      /[{}]/.test(map.lookup_path.replace('{id}', ''))) {
    invalid('lookup_path', 'expected a path starting with a single / and containing exactly one {id}.');
  }
  for (const field of ['request_text_field', 'completed_status']) {
    if (!nonEmpty(map[field])) invalid(field, 'expected a non-empty string.');
  }
  if (!isObject(map.response)) invalid('response', 'expected an object with response field paths.');
  for (const field of responseFields) {
    const value = map.response[field];
    if (!nonEmpty(value) || !value.split('.').every(nonEmpty)) {
      invalid(`response.${field}`, 'expected a non-empty dot-separated field path.');
    }
  }
  return map;
}

function fieldAt(value, path) {
  for (const segment of path.split('.')) {
    if (!isObject(value) || !Object.hasOwn(value, segment)) {
      throw new Error(`Response is missing mapped field ${JSON.stringify(path)}.`);
    }
    value = value[segment];
  }
  return value;
}

export function externalBackend(url, mapPath, profile = defaultProfile) {
  const base = new URL(url);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('--backend-url must be an HTTP(S) base URL without credentials, a query, or a fragment.');
  }
  const baseUrl = base.origin + base.pathname.replace(/\/+$/, '');
  const map = loadMapping(mapPath);
  async function request(path, signal, body) {
    const method = body === undefined ? 'GET' : 'POST';
    const response = await fetch(baseUrl + path, {
      method, signal, redirect: 'error',
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    if (response.status !== 200 && !(method === 'POST' && response.status === 201)) {
      throw new Error(`External backend ${method} returned HTTP ${response.status}.`);
    }
    const data = await response.json();
    const fields = Object.fromEntries(responseFields.map((name) => [name, fieldAt(data, map.response[name])]));
    if ((!nonEmpty(fields.id) && !Number.isSafeInteger(fields.id)) || fields.id === '.' || fields.id === '..') {
      throw new Error('Mapped work-order ID must be a non-empty string or safe integer and usable in the lookup path.');
    }
    if (typeof fields.text !== 'string' || !nonEmpty(fields.status)) {
      throw new Error('Mapped work-order text and status must be strings, with a non-empty status.');
    }
    if (!validDevice(fields.device, profile) || !profile.categories.includes(fields.category)) {
      throw new Error('Mapped device or category failed validation.');
    }
    return { id: String(fields.id), text: fields.text, status: fields.status,
      result: { device: fields.device, category: fields.category } };
  }
  return {
    create: (text, signal) => request(map.create_path, signal, { [map.request_text_field]: text }),
    lookup: (id, signal) => request(map.lookup_path.replace('{id}', encodeURIComponent(id)), signal),
    completedStatus: map.completed_status,
  };
}
