# Security policy

kubedeck runs with your Kubernetes credentials, so security reports are taken seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through GitHub instead:
[**Security → Report a vulnerability**](https://github.com/cardoso010/kubedeck/security/advisories/new).

Include what you found, how to reproduce it, and what an attacker could do with it. You should
get a first answer within a week. Once a fix is released, the advisory is published with
credit to you, unless you prefer otherwise.

## Supported versions

Only the latest release gets security fixes. The app updates itself, so staying current is
one click (**Install and restart** in the sidebar).

## Scope

Things that matter most here:

- Anything that sends cluster data, credentials or Secret values somewhere the user did not
  ask for (including the "Explain with Claude" request, which must never include Secrets or
  env values).
- Ways around read-only mode or the production confirmations.
- The self-updater accepting a package that is not signed with the project's key.
- Running commands or opening files the user did not ask for (port forwards, the login
  command, exec).

Out of scope: what a user can already do with their own kubeconfig and RBAC permissions, and
vulnerabilities in Kubernetes, Helm or the cluster itself (report those upstream).
