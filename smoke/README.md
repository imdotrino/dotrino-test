# Smoke E2E del ecosistema

Levanta el ecosistema entero **en local** y comprueba el camino real de punta a punta:
emparejar un dispositivo con una bóveda, aprobar con el código correcto, **rechazar el
equivocado sin emitir certificado**, entrar en el acta del perfil, y que revocar corte el
acceso de verdad.

Las suites:

```sh
npm run smoke                  # protocolo completo, todo en un proceso (rápido)
npm run smoke:tui              # la TUI de la bóveda: emparejar y administrar a teclazos
npm run smoke:dispositivos     # cada dispositivo en su propia máquina efímera
npm run smoke:configuracion    # la CONFIGURACIÓN proxio ↔ bóveda, cada uno en su caja
npm run smoke:consola          # la CONSOLA REMOTA: admitir a distancia, sin tocar el PC
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

## `smoke:tui` — emparejar y administrar DESDE LA TUI

Las demás suites le hablan a la bóveda por su **CLI**. La **TUI** es código distinto —su
propio canal (`vaultControl.js`), sus pantallas y su propio estado— y no la probaba nadie
de punta a punta: los tres fallos del 2026-08-13 vivían todos ahí.

Aquí se pilota la TUI **de verdad**: se abre en un terminal (un pty, con `script(1)`), se
le teclean las mismas teclas que teclearía el dueño y se lee lo que dibuja. Lo que se
comprueba no es el texto, es que **el acta de la bóveda cambie** como corresponde a cada
tecla — y, en la última, que quitar un aparato le corte el acceso de verdad.

No necesita compilar nada (corre la TUI desde el código) ni credenciales: proxy y bóveda
locales, como el resto.

Escenarios:

1. Abre, entra en la bóveda y la lista sale **entera**: una bóveda recién hecha ya tiene un
   miembro —ella misma—, así que *«sin dispositivos enrolados»* ahí no es una lista vacía,
   es que **el acta no llegó**. Y llega en lo que tarda el daemon, no en seis segundos.
2. **`P` empareja**: sale el QR, un aparato real se conecta, `A` + los seis dígitos, y entra
   en el acta con su certificado — y **aparece en la lista sin refrescar a mano**.
3. **Código equivocado**: se dice que no coincide, **no entra nadie**, y el pendiente sigue
   ahí para reintentar con el bueno.
4. **`C` son los permisos**: los cuatro en cristiano; *administrar* se **pregunta** antes de
   darlo (es el que deja a ese aparato meter y sacar dispositivos sin venir aquí) y se quita
   sin preguntar. El acta lo recoge en los dos sentidos.
5. La bóveda **no se echa a sí misma**: `V` sobre el master lo dice y no manda la orden.
6. **`V` quita un aparato**: sale del acta y la bóveda **deja de firmarle**.
7. Y al expulsado que **vuelve a llamar se le ATIENDE**: se le contesta y se le manda el
   aviso **firmado** por la maestra, que es lo único que le borra la cuenta —un
   «unauthorized» pelado no va firmado y no puede borrar nada (wipe-DoS). Si la bóveda le
   colgara, el aparato se quedaría enseñando una cuenta que ya no existe.

**Ya sirvió:** destapó dos averías de la TUI que no veía ninguna prueba unitaria — que
aprobar guardaba los certificados pero **no el acta** (el aparato recién admitido no salía
en la lista, y por eso «quitar el último» se llevaba por delante a otro), y que con el
**código equivocado** la pantalla decía *«Dispositivo aprobado»*, se olvidaba del pendiente
y dejaba al aparato esperando sin forma de reintentar.

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
4. **Rotar no se aplica solo**: cambiar el valor en la bóveda no alcanza a un proxio en
   marcha; la configuración se lee al arrancar.
5. **Pero la bóveda AVISA**: al guardar manda un aviso firmado. El agente estándar
   termina y su supervisor lo levanta limpio; el proxio no —reiniciarlo corta el
   transporte de todos—, así que lo publica en `GET /peers` y el momento lo eliges tú.
6. Avisa de lo que llegó tarde y **no está en efecto** hasta reiniciar.

Requiere el binario de la bóveda (`cd ../dotrino-vault && bash packaging/build.sh`).

**Ya sirvió:** destapó que el arnés levanta el proxio con `NODE_ENV=test`, y con eso el
bucle del vault **no arranca** — por eso este camino no lo cubría ningún test. Y que la
lista de "variables que sólo se leen al arrancar" del proxio, escrita a mano, ya se
había quedado corta; ahora se enumera al revés (qué SÍ se re-aplica), que falla del lado
seguro.

## `smoke:consola` — administrar el perfil desde otro aparato

La consola remota (`dotrino-vault/docs/consola-remota.md`): un dispositivo con la
capacidad **«administra»** admite y expulsa miembros **sin que el dueño vaya al PC**. Eso
solo se puede probar con las máquinas separadas de verdad, porque lo que falla es
justamente lo que pasa **entre** ellas.

Tres cajas: la **bóveda** (el binario, manejado con su CLI real), el **admin** y el
aparato **nuevo**. Escenarios:

1. El admin entra como un aparato normal — y el QR **nunca** otorga administración.
2. Sin «administra», la consola remota le dice que no.
3. El dueño concede `+administra` en el PC, y el permiso **llega al cert al renovar**.
4. **El paso clave:** el admin abre un emparejamiento, el aparato nuevo muestra su código y
   el admin lo aprueba **desde su máquina**. La bitácora anota **quién** aprobó.
5. Un admin **no** puede crear otro admin ni emparejar servicios (se corta en la bóveda).
6. El aviso firmado llega a los demás aparatos: administrar a distancia no es invisible.
7. **F4** — datos sensibles guardados y recuperados por el camino real, y sin quedar en
   claro en el disco de la bóveda.
8. Quitar `-administra` corta la administración **en el acto**, sin esperar a la caducidad.

Requiere el binario (`cd ../dotrino-vault && bash packaging/build.sh`).

**Ya sirvió, y de sobra:** con F1–F5 «implementadas» y 141 pruebas verdes, la consola
remota **no funcionaba**. Destapó tres fallos que se tapaban entre sí — el vault colgado de
un `@dotrino/identity` anterior a la capacidad `admin` (el acta la descartaba en silencio),
el scope del cert copiado del cert viejo al renovar (un permiso concedido no llegaba nunca,
y uno retirado seguía valiendo hasta 30 días) y las operaciones de admin sin cruzar con el
acta. Detalle en `dotrino-vault/docs/consola-remota.md §11`.

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
