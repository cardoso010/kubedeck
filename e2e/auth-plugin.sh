#!/bin/sh
# Kubeconfig exec credential plugin for the e2e tests: hands out whatever token is in
# e2e/.auth-token, so tests can revoke and renew credentials the way an AWS session expires.
token="$(cat "$(dirname "$0")/.auth-token" 2>/dev/null)"
printf '{"apiVersion":"client.authentication.k8s.io/v1beta1","kind":"ExecCredential","status":{"token":"%s"}}\n' "$token"
