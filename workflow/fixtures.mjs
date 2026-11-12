import { readFileSync } from 'node:fs';
import { defaultProfile, validDevice } from './profile.mjs';

const caseFields = ['id', 'text', 'expected', 'variants'];
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function loadFixtures(path, profile = defaultProfile) {
  const invalid = (location, message) => {
    throw new Error(`Fixtures "${path}", ${location}: ${message}`);
  };
  let json;
  try {
    json = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
  } catch (error) {
    invalid('root', `could not read a UTF-8 file (${error.code ?? 'read error'}).`);
  }

  let data;
  try {
    data = JSON.parse(json);
  } catch (error) {
    const position = / at position \d+(?: \(line \d+ column \d+\))?/.exec(error.message)?.[0] ?? '';
    invalid('root', `invalid JSON${position}.`);
  }
  if (!Array.isArray(data) || data.length === 0) invalid('root', 'expected a non-empty array of samples.');

  const ids = new Set();
  return data.map((entry, index) => {
    const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
    const location = `sample ${index + 1}${id ? ` (id ${JSON.stringify(id)})` : ''}`;
    const bad = (field, message) => invalid(`${location}, field ${field}`, message);
    const checkText = (value, field) => {
      // Browser textareas normalize line endings before submitting a work order.
      const text = typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : '';
      if (!text || !text.isWellFormed()) bad(field, 'expected non-empty Unicode text.');
      // The backend forwards a JSON request with a space after the key separator.
      if ([...text].length > 4000 || Buffer.byteLength(JSON.stringify({ text })) + 1 > 16 * 1024) {
        bad(field, 'text must be at most 4000 characters and fit in a 16 KiB JSON request.');
      }
      return text;
    };

    if (!isObject(entry)) bad('sample', 'expected an object.');
    if (!id) bad('id', 'expected a non-empty string.');
    if (ids.has(id)) bad('id', 'sample IDs must be unique.');
    ids.add(id);

    const extraField = Object.keys(entry).find((field) => !caseFields.includes(field));
    if (extraField !== undefined) bad(JSON.stringify(extraField), 'unknown field.');
    const text = checkText(entry.text, 'text');
    const { expected, variants = [] } = entry;
    if (!isObject(expected)) bad('expected', 'expected an object with device and category.');
    if (!validDevice(expected.device, profile)) {
      bad('expected.device', `expected null or an identifier matching ${profile.device_id_pattern}.`);
    }
    if (!profile.categories.includes(expected.category)) {
      bad('expected.category', `expected one of ${profile.categories.join(', ')}.`);
    }
    const extraExpected = Object.keys(expected).find((field) => field !== 'device' && field !== 'category');
    if (extraExpected !== undefined) bad(`expected.${JSON.stringify(extraExpected)}`, 'unknown field.');
    if (!Array.isArray(variants)) bad('variants', 'expected an array of strings.');

    return {
      id, text, expected,
      variants: variants.map((variant, i) => checkText(variant, `variants[${i}]`)),
    };
  });
}
