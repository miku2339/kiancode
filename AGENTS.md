# kiancode

- Core is Apache-2.0 and independent of Hermes, OpenClaw, QIMAKE credentials, and recovered proprietary source.
- TypeScript uses two spaces, single quotes, semicolons, and explicit public interfaces.
- Keep personal data, hostnames, voice references, secrets, and production configuration outside this repository.
- Test behavior through public interfaces. Run `npm run check` before delivery.
- Shared work is divided by directory; do not overwrite another agent's changes.
- Production uses PostgreSQL. SQLite is for local development and tests only.
- Preserve the distinction between dispatch, confirmation, and unknown external outcomes.

