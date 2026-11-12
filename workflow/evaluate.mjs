export function labelsMatch(actual, expected) {
  return actual?.device === expected.device && actual.category === expected.category;
}

async function readPrediction(predict, text) {
  try {
    const result = await predict(text);
    const { device, category } = result;
    if (Object.keys(result).length === 2 &&
        (device === null || (typeof device === 'string' && /^pump-[1-9][0-9]*$/.test(device))) &&
        ['noise', 'leak', 'overheat', 'unknown'].includes(category)) {
      return { device, category };
    }
  } catch {
    // Keep provider responses and diagnostics out of the report.
  }
  return null;
}

export async function evaluate(cases, predict) {
  const accuracy = { passed: 0, total: 0 };
  const robustness = { passed: 0, total: 0 };
  const rows = [];

  for (const { id, text, expected, variants } of cases) {
    const actual = await readPrediction(predict, text);
    const passed = labelsMatch(actual, expected);
    rows.push({ id, kind: 'Accuracy', text, expected, actual, passed });
    accuracy.total += 1;
    accuracy.passed += Number(passed);

    for (const [index, variant] of variants.entries()) {
      const prediction = await readPrediction(predict, variant);
      const variantPassed = passed && labelsMatch(prediction, expected);
      rows.push({ id: `${id}.${index + 1}`, kind: 'Robustness', text: variant,
        expected, actual: prediction, passed: variantPassed });
      robustness.total += 1;
      robustness.passed += Number(variantPassed);
    }
  }

  return { accuracy, robustness, rows };
}
