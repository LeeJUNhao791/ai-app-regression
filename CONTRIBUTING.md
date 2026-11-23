# Contributing

For a bug report, include your operating system, Node.js and Python versions, command, expected result, and actual result. Include the failed step and a small report excerpt after removing credentials and private data. State whether the run used fixed model responses or a live model, and whether Android ran or was skipped.

Use Node.js 22+ and Python 3.10+. Install the JavaScript dependencies with `npm ci`, then run the checks relevant to your change.

```sh
npm test
python -B -m unittest discover -s tests -p 'test_*.py' -v
```

For workflow changes, follow the [getting-started guide](docs/getting-started.md) to run the browser and Linux service checks. Describe the commands and results in your pull request. Record Android device checks separately with the device and Android version.
