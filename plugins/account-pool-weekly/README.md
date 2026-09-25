# Account Pooler (Weekly Priority)

This is the standalone install of the forked Account Pooler. It reuses the
implementation in `../account-pool` and has the distinct plugin ID
`account-pool-weekly`, because BB reserves `account-pool` for its bundled plugin.
The shared implementation uses the installed plugin ID for its HTTP route.

Build and install it from this repository checkout:

```sh
bb plugin build plugins/account-pool-weekly
bb plugin install plugins/account-pool-weekly --yes
```

The installer does not move data between plugin IDs. To keep existing accounts,
disable the bundled plugin, copy its `~/.bb/plugins/account-pool/` data directory
to `~/.bb/plugins/account-pool-weekly/`, then install this plugin. Keep the old
data directory for rollback. After installation, set
`bb pool config set routingMode weekly-reset` to activate the new mode.
