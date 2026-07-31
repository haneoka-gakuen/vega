# Security policy

## Supported versions

Vega is in a `0.1` development series. Security fixes are applied to the latest commit on `main`; no older line is currently maintained.

## Reporting

Do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability-reporting feature for the repository and include:

- affected package and version or commit;
- a minimal reproduction;
- expected impact and required user interaction;
- any known mitigation.

Please do not include third-party credentials, proprietary game data, or personal information. Maintainers will acknowledge a complete report as capacity allows and coordinate disclosure after a fix is available.

## Trust boundaries

Treat projects, plugins, asset URLs, preview peers, and save data as untrusted. Hosts remain responsible for URL policy, CSP, sandboxing, origin isolation, permission prompts, and platform signing. A Vega plugin receives only explicitly granted capabilities; it must not be treated as equivalent to trusted application code.
