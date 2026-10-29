## What and why

<!-- What this changes, and the problem it solves. Link the issue if there is one. -->

## Checklist

- [ ] `npx tsc --noEmit` and `cargo clippy --all-targets -- -D warnings` pass
- [ ] The end-to-end suite passes on kind (see README, "Testing"), or CI ran it
- [ ] New commands have a wrapper in `src/api.ts`, a case in `src/dev-mock.ts` and e2e coverage
- [ ] Commands that change the cluster call `state.writable()?` and keep the production confirmation
- [ ] Visible UI changes: screenshots attached, `npm run screenshots` rerun if README images changed
