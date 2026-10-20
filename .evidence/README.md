# .evidence

Evidence bundles exported by local demo runs land here (ignored by Git).

The `verifier` and `verifier-online` Compose tools mount this directory
read-only at `/workspace/.evidence`, so a bundle must live here to be
verified. Public trust-root files can be placed here too:

```bash
docker compose build
docker compose run --rm verifier verify .evidence/<bundle>.json \
  --issuer-trust .evidence/<issuer>.pub --authority-trust .evidence/<authority>.pub \
  [--service-trust .evidence/<service>.pub]
```

Once the stack has run, the published keys are also available read-only at
`/trust/issuer/trusted-issuer`, `/trust/authority/authority.pub` and
`/trust/service/service.pub`.
