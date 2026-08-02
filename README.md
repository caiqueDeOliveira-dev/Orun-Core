# Orun-Core

Núcleo compartilhado do ecossistema Orun. Um produto = um repositório:
`OrunOS` (desktop), `OrunOs-Mobile`, `Orun-TV`, `Orun-Shield`. O que é comum
a todos mora aqui e é consumido como dependência git (`github:...tag`).

## O que tem dentro

- **Engine de sync híbrido** `SyncService` — SQLite continua sendo a fonte de
  verdade local (instante, offline); um worker empurra `sync_queue` para o
  Supabase com backoff exponencial e dead-letter, e puxa mudanças remotas com
  pull paginado e last-write-wins. Realtime opcional por websocket.
  (extraído de `packages/supabase-sync` do OrunOs-Mobile)
- **Outbox** `enqueueUpsert`/`enqueueDelete` — fila cada escrita local para o
  sync chegar ao Supabase de forma confiável, sem bloquear o app.
- **Backfill** — migração única para subir as linhas locais existentes antes
  de ligar o sync contínuo.
- **Client** `getSupabaseClient`/`initSupabaseFromKeychain` — client com
  `service_role` que SÓ pode rodar no processo principal de cada app
  (nunca no renderer/mobile).
- **Controle de satélites** `SatelliteController` — heartbeats (`devices`),
  fila de comandos (`commands`), e o contrato de visibilidade entre hub e
  satélites.
- **Schemas IPC** (zod) — validação de payloads que cruzam a fronteira
  renderer -> main.
- **Migrations Supabase** — schema + RLS + Realtime (tabelas syncáveis,
  `devices` e `commands`).

## Modelo hub-and-spoke

```
         ┌─────────────── Supabase (contrato único) ───────────────┐
         │  devices (heartbeat ~30s)   commands (fila hub->satélite) │
         └───▲────────────▲───────────▲──────────────▲──────────────┘
             │            │           │              │
        ┌────┴───┐   ┌────┴────┐   ┌──┴───┐      ┌───┴────┐
        │ DESKTOP│   │ MOBILE  │   │  TV  │      │ SHIELD │
        │  hub   │   │  hub    │   │ satélite │  │satélite│
        └────────┘   └─────────┘   └──────┘      └────────┘
```

- **Desktop + Mobile** = hubs unidos: leem/escrevem tudo (`listDevices`,
  `sendCommand`) e são espelhados via sync.
- **TV e Shield** = satélites cegos entre si: só `heartbeat()` + `pollCommands()`
  + `updateCommandStatus()`. Nunca consultam as linhas um do outro.
- **Desktop sabe tudo** sobre TV/Shield; TV/Shield não sabem nada um do outro.

## Consumo (git dependency)

Nos apps, declarar com tag de versão:

```jsonc
// desktop / mobile / tv / shield
"dependencies": {
  "@orun/core": "github:caiqueDeOliveira-dev/Orun-Core#v0.1.0"
}
```

O build (ESM + CJS + types) é commitado em `dist/` para a instalação via git
funcionar sem rodar build na máquina do consumidor. O Electron (CJS) resolve
via `require`; Expo/Metro (ESM) via `import`.

`better-sqlite3` é `peerDependency` — cada app mantém a sua instância
(`electron-builder install-app-deps` no desktop).

## Credenciais

`service_role` NUNCA vai em `.env` empacotado. Cada app lê do keychain do SO
no processo principal:

| chave                        | valor                    |
| ---------------------------- | ------------------------ |
| `orun.supabase.url`          | `https://XXXX.supabase.co` |
| `orun.supabase.serviceRoleKey` | `eyJ...` (service_role) |

Sem credenciais no keychain, o sync roda 100% local (sem erro).

## Desenvolvimento

```bash
npm install
npm run typecheck
npm test
npm run build   # gera dist/ (ESM + CJS + d.ts) — commitar junto com o código
```

## Migrations

As migrations em `supabase/migrations/` são aplicadas no projeto Supabase
compartilhado. `0007_ecosystem.sql` adiciona `devices` + `commands` (RLS +
Realtime) e não altera o schema SQLite local dos apps.
