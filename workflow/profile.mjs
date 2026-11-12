import { readFileSync } from 'node:fs';

export const defaultProfile = {
  device_id_pattern: 'pump-[1-9][0-9]*',
  categories: ['noise', 'leak', 'overheat', 'unknown'],
};

const identifier = (value) => typeof value === 'string' && value.length > 0 && !/[^A-Za-z0-9_-]/.test(value);

export function loadProfile(path) {
  const invalid = (field, message) => {
    throw new Error(`Profile "${path}", field ${field}: ${message}`);
  };
  let profile;
  try {
    profile = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path)));
  } catch {
    invalid('root', 'expected a readable UTF-8 JSON file.');
  }
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) invalid('root', 'expected an object.');
  const fields = ['system_prompt', 'device_id_pattern', 'categories'];
  const unknown = Object.keys(profile).find((field) => !fields.includes(field));
  if (unknown !== undefined) invalid(JSON.stringify(unknown), 'unknown field.');
  if (typeof profile.system_prompt !== 'string' || !profile.system_prompt.trim()) {
    invalid('system_prompt', 'expected a non-empty string.');
  }
  if (typeof profile.device_id_pattern !== 'string' || !profile.device_id_pattern.trim()) {
    invalid('device_id_pattern', 'expected a non-empty regular expression.');
  }
  try {
    new RegExp(`^(?:${profile.device_id_pattern})$`);
  } catch {
    invalid('device_id_pattern', 'invalid regular expression.');
  }
  if (!Array.isArray(profile.categories) || !profile.categories.length || !profile.categories.every(identifier) ||
      new Set(profile.categories).size !== profile.categories.length) {
    invalid('categories', 'expected distinct, non-empty labels using ASCII letters, digits, underscores, or hyphens.');
  }
  return profile;
}

export function validDevice(value, profile = defaultProfile) {
  return value === null || (identifier(value) && new RegExp(`^(?:${profile.device_id_pattern})$`).test(value));
}
