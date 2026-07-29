# Smoke E2E del ecosistema

Levanta el ecosistema entero **en local** y comprueba el camino real de punta a punta:
emparejar un dispositivo con una bóveda, aprobar con el código correcto, **rechazar el
equivocado sin emitir certificado**, entrar en el acta del perfil, y que revocar corte el
acceso de verdad.

Las suites:

```sh
npm run smoke                  # protocolo completo, todo en un proceso (rápido)
npm run smoke:dispositivos     # cada dispositivo en su propia máquina efímera
npm run smoke:configuracion    # la CONFIGURACIÓN proxio ↔ bóveda, cada uno en su caja
npm run smoke:navegador        # el navegador de verdad (Playwright)
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

## `smoke:configuracion` — de dónde saca su configuración un agente

Un agente enrolado saca su configuración del vault, y **el vault manda**: sus valores
pisan los del `.env` de la máquina. Eso es lo que hace barata la rotación —se cambia en
un solo lugar y ninguna copia rancia olvidada en un VPS sigue ganando—, así que hay que
probarlo, no suponerlo.

Va en **cajas separadas** porque la bóveda va a vivir en su propio VPS y el ciclo que
define este diseño sólo es real entre máquinas: **el vault le habla a sus servicios POR
EL PROXIO**. De ahí la única excepción del ecosistema: el proxio no puede esperar al
vault (esperaría a alguien que necesita el proxio escuchando), así que arranca con lo
que tenga y aplica la configuración cuando llega. Todos los demás agentes **sí** esperan.

**Y no se le cree a ningún log.** Se levantan **dos Cloudflare falsos** —uno para el
valor del `.env`, otro para el del vault— y un cliente real pide credenciales TURN: el
que conteste delata qué configuración está de verdad en efecto, con qué llave y con qué
token. La precedencia queda probada de caja negra.

Escenarios:

1. Sin bóveda, el proxio corre con su `.env` (el modo del que se autohospeda) y no
   menciona ningún vault.
2. Se enrola con el comando real y la bóveda le **cede** la configuración: el log dice
   qué claves pisó y las credenciales pasan a salir del destino del **vault**.
3. **No espera a la bóveda**: con ella caída el transporte sirve igual, cae a lo que
   tiene y reintenta en vez de rendirse.
4. **Rotar no llega en caliente**: cambiar el valor en la bóveda no alcanza a un proxio
   en marcha; hace falta reiniciarlo. Es el límite de hoy, fijado como hecho comprobado
   y no como sorpresa.
5. Avisa de lo que llegó tarde y **no está en efecto** hasta reiniciar.

Requiere el binario de la bóveda (`cd ../dotrino-vault && bash packaging/build.sh`).

**Ya sirvió:** destapó que el arnés levanta el proxio con `NODE_ENV=test`, y con eso el
bucle del vault **no arranca** — por eso este camino no lo cubría ningún test. Y que la
lista de "variables que sólo se leen al arrancar" del proxio, escrita a mano, ya se
había quedado corta; ahora se enumera al revés (qué SÍ se re-aplica), que falla del lado
seguro.

## `smoke:navegador` — el navegador de verdad (Playwright)

Lo que no se puede probar sin navegador: el **iframe de identidad en otro origen** (con su
IndexedDB y sus llaves **no extraíbles**, que solo existen en un navegador), el `postMessage`
entre orígenes, y la pantalla que ve la persona.

Va **entero en local**: la consola y el iframe se sirven desde el disco, y el proxy y la
bóveda se levantan aquí. No toca producción. Requiere el build de la consola:

```sh
cd ../dotrino-vault/web && npm run build
npx playwright install chromium     # la primera vez
```

Escenarios:

1. La consola abre y muestra el acta de este navegador, con el aviso de que perderlo es
   perder el perfil **a la vista**.
2. Se empareja con la bóveda: el código del QR llega por el `#fragment`, la consola enseña
   los seis dígitos, se aprueban en la bóveda y el navegador entra en su acta.
3. **Con el código equivocado**, la consola no da por conectado a nadie y sigue esperando.
4. **La llave privada del navegador no es extraíble**: existe en IndexedDB, pero pedirle los
   bytes con `exportKey` falla. Ni el propio código puede sacarla de esa máquina.

Para desarrollar en local, la consola acepta `?vault=<url>` y apunta la identidad a un iframe
propio — **solo si se está sirviendo desde localhost**, para que un enlace no pueda apuntar
la identidad de nadie a un origen ajeno.

## Pendiente

- Traspaso del master y master obsoleto (restaurar un respaldo de la bóveda).
