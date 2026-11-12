const responseFailures = new Map([
  ['provider_timeout', 'Provider request timed out.'],
  ['provider_connection_closed', 'Provider closed the connection before sending a complete response.'],
  ['provider_protocol_error', 'Provider sent an incomplete or invalid HTTP response.'],
  ['provider_network_error', 'The network or TLS connection to the provider failed.'],
  ['provider_http_error', 'Provider returned an HTTP error.'],
  ['invalid_provider_response', 'Provider response did not match Chat Completions format.'],
  ['empty_model_content', 'Model returned empty message content.'],
  ['invalid_model_json', 'Model message was not valid JSON or a single JSON code block.'],
  ['invalid_prediction_fields', 'Model JSON had missing or unexpected fields.'],
  ['invalid_device', 'Device field failed validation.'],
  ['invalid_category', 'Category field failed validation.'],
  ['upstream_unavailable', 'The model service could not reach or read the provider.'],
]);

class PredictionFailure extends Error {}

export async function requestPrediction(modelUrl, text, signal) {
  const response = await fetch(`${modelUrl}/predict`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal,
  });
  if (response.status !== 200) {
    const problem = await response.json().catch(() => null);
    const code = problem?.error;
    const status = problem?.provider_status;
    if (code === 'provider_http_error' && Number.isInteger(status) && status >= 100 && status <= 599) {
      throw new PredictionFailure(`Provider returned HTTP ${status}.`);
    }
    throw new PredictionFailure(responseFailures.get(code) ?? `Model service returned HTTP ${response.status}.`);
  }
  try {
    return await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) throw new PredictionFailure('Model service did not return valid JSON.');
    throw error;
  }
}

export function labelsMatch(actual, expected) {
  return actual?.device === expected.device && actual.category === expected.category;
}

export const issueCategories = ['noise', 'leak', 'overheat', 'unknown'];

export function validDevice(value) {
  return value === null || (typeof value === 'string' && /^pump-[1-9][0-9]*$/.test(value));
}

async function checkCase(predict, text, expected, originalPassed = true) {
  const started = performance.now();
  let actual = null;
  let failureReason;
  try {
    const result = await predict(text);
    const { device, category } = result ?? {};
    if (result && Object.keys(result).length === 2 && validDevice(device) && issueCategories.includes(category)) {
      actual = { device, category };
    } else {
      failureReason = 'Prediction fields failed validation.';
    }
  } catch (error) {
    if (error instanceof PredictionFailure) failureReason = error.message;
    else if (error?.name === 'TimeoutError') failureReason = 'Request to the model service timed out.';
    else failureReason = 'Prediction request could not be completed.';
  }
  const matches = labelsMatch(actual, expected);
  if (!failureReason && !matches) failureReason = 'Labels differ from the reference.';
  if (!failureReason && !originalPassed) failureReason = 'Original case failed.';
  return { actual, durationMs: Math.round(performance.now() - started),
    passed: matches && originalPassed, failureReason: failureReason ?? null };
}

export async function evaluate(cases, predict) {
  const accuracy = { passed: 0, total: 0 };
  const robustness = { passed: 0, total: 0 };
  const rows = [];

  for (const { id, text, expected, variants } of cases) {
    const result = await checkCase(predict, text, expected);
    rows.push({ id, kind: 'Accuracy', text, expected, ...result });
    accuracy.total += 1;
    accuracy.passed += Number(result.passed);

    for (const [index, variant] of variants.entries()) {
      const variantResult = await checkCase(predict, variant, expected, result.passed);
      rows.push({ id: `${id}.${index + 1}`, kind: 'Robustness', text: variant,
        expected, ...variantResult });
      robustness.total += 1;
      robustness.passed += Number(variantResult.passed);
    }
  }

  return { accuracy, robustness, rows };
}
