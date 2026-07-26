# Smoke E2E del ecosistema

Levanta el ecosistema entero **en local** y comprueba el camino real de punta a punta:
emparejar un dispositivo con una bóveda, aprobar con el código correcto, **rechazar el
equivocado sin emitir certificado**, entrar en el acta del perfil, y que revocar corte el
acceso de verdad.

Hay **dos** suites:

```sh
npm run smoke                  # protocolo completo, todo en un proceso (rápido)
npm run smoke:dispositivos     # cada dispositivo en su propia máquina efímera
node smoke/run.mjs --verbose   # con los logs del proxy y de la bóveda
```

## Qué levanta

| Pieza | Cómo |
|---|---|
| **Proxy** | `dotrino-proxy` en un puerto libre (`ws://localhost:<puerto>`) |
| **Bóveda** | el daemon de `dotrino-vault` con `DOTRINO_VAULT_DIR` en un directorio temporal |
| **Dispositivos y agentes** (terminal, ia, bot) | identidades Node que usan el **cliente real**, no una imitación |

**No toca producción y no necesita credenciales**: proxy propio, datos en `/tmp`, todo se
borra al terminar. Por eso puede correr en CI (`docs/acta-de-perfil.md §5`).

Se apoya en el código real importándolo por ruta desde sus repos
(`dotrino-vault/src/client.js`, `dotrino-identity/src/node.js`): si el protocolo cambia, el
smoke se entera en vez de seguir probando una copia vieja.

## Escenarios

1. La bóveda arranca, tiene identidad y su acta con un solo miembro.
2. Emparejar con el código correcto → cert emitido para ese dispositivo y admitido en el acta.
3. **Código equivocado → ningún certificado**, y con el bueno después sí entra.
4. Agentes headless (terminal, ia, bot) se enrolan con el mismo protocolo.
5. Revocar corta el acceso: la bóveda deja de firmarle.
6. Una identidad que ya existía se une al perfil y trae su **certificado de continuidad**.

## `smoke:dispositivos` — cada dispositivo en su propia máquina

Un dispositivo de verdad es una **máquina aparte**. Esta suite lo prueba como tal: cada uno
arranca en su propia caja efímera (un contenedor), genera SU llave en SU disco, no ve el
disco de ningún otro, y se empareja con la bóveda por el proxy.

Y la bóveda corre aquí **como binario**, no desde el código: el mismo `dotrino-vaultd` que
se instala un usuario, manejado con su CLI real (`--ctl pair` / `--ctl approve` /
`--ctl members`). Requiere compilarlo antes:

```sh
cd ../dotrino-vault && bash packaging/build.sh
```

Los seis caminos de enrolamiento del ecosistema, que son código distinto:

| Caja | Qué representa | De dónde sale el enrolamiento |
|---|---|---|
| `navegador` | navegador / PWA, y los bots | `@dotrino/identity` |
| `cliente-node` | el cliente de referencia | `dotrino-vault/src/client.js` |
| `terminal` | el agente de la terminal | `dotrino-terminal/agent/link.js` |
| `ia` | el agente de IA | `@dotrino/remote-agent/link` (lo reusa) |
| `remote-agent` | el agente remoto genérico | `@dotrino/remote-agent/link` |
| `servicio-proxy` | un **servicio** (entra con CN) | `@dotrino/vault/service` |

**Motores.** Con Docker, un contenedor por dispositivo (`/eco` montado de solo lectura,
disco propio en `/data`, red del host para llegar al proxy). Sin Docker cae a cajas locales
—un proceso con su `HOME` propio—, que aíslan los datos pero no el sistema. Se fuerza con
`SMOKE_BACKEND=docker|local`.

**Ya sirvió:** destapó que el binario «autosuficiente» no arranca en un Debian limpio porque
le falta `libatomic1`. Ahora el `.deb` la declara y el README lo dice.

## Pendiente

- **Dispositivo navegador con Playwright** contra `vault.dotrino.com` y el iframe de
  identidad. Es el único escenario que necesita navegador de verdad; el camino de código que
  usa el navegador (`@dotrino/identity`) ya está cubierto en las dos suites.
- Traspaso del master y master obsoleto (restaurar un respaldo de la bóveda).
