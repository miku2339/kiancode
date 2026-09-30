# Implementation and acceptance

The complete release requires all of these gates; source code or unit tests alone do not establish deployment.

1. Core: persistence, scoped conversations/memory, real model/tool loop, durable task recovery, scheduler, agents, expert routing, MoA, Skills/MCP.
2. Account: identity and credential migration, OTP/Passkey/OIDC, revocation, recovery, and all existing downstream contracts.
3. Clients: iPhone and macOS task/chat continuity, workspace execution, approval, and artifact readback.
4. Adapters: delivery confirmation and each independently deployed channel or media adapter's acceptance checks.
5. Deployment: primary PostgreSQL and attachment storage, a bounded encrypted outage buffer, restore drill, restart and network-failure recovery.
6. Release: independent clean installation, migration comparisons, actual device verification, and reversible cutover.

Production cutover has not occurred. The original installations remain the serving systems until the acceptance gates pass.
