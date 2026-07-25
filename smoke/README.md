# Smoke E2E del ecosistema

Levanta el ecosistema entero **en local** y comprueba el camino real de punta a punta:
emparejar un dispositivo con una bóveda, aprobar con el código correcto, **rechazar el
equivocado sin emitir certificado**, entrar en el acta del perfil, y que revocar corte el
acceso de verdad.

```sh
npm run smoke            # todo
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

## Pendiente

- **Dispositivo navegador con Playwright** contra `vault.dotrino.com` y el iframe de
  identidad. Es el único escenario que necesita navegador; el resto del protocolo ya queda
  cubierto arriba.
- Escenarios de las fases siguientes: traspaso del master, master obsoleto (restaurar un
  respaldo), contenido compartido.
