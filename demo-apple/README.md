# Demo de Terminal para la revisión de Apple

Una bóveda y una máquina en **un contenedor**, para que App Review pruebe Dotrino Terminal
sin tener bóveda ni máquina propias. El revisor recibe una dirección `apple@AB12-CD34-EF56` y
una contraseña, entra con «Iniciar sesión» y la app le enseña «Máquina de prueba» con una
shell real.

No es una demo abierta: es una sola cuenta, para la revisión.

## Cómo está hecho

| Usuario | Corre | Puede tocar |
|---|---|---|
| `vault` | `dotrino-vaultd` | `/data/run/vault` (0700) y su socket en `/run/vault` (0700) |
| `tester` | `dotrino-terminal-agent` y las shells del revisor | su home y el enlace de la máquina |

- **Cada arranque restaura la copia** (`/data/copia` → `/data/run`), con el home del revisor
  incluido. Lo que cambie se pierde al reiniciar. La dirección no cambia: sale del perfil, que
  viaja en la copia.
- **El `machine-id` vive en el volumen** (`/data/machine-id`). De él sale la clave con la que la
  bóveda cifra su disco: sin él la copia no abre en otro contenedor (`kek-machine-changed`).
- La imagen no tiene binarios setuid. `/data` se atraviesa pero no se lista; la copia, el
  `machine-id` y la dirección solo los lee root.
- Paquetes de npm con versión fija (`VAULTD_VERSION`, `AGENT_VERSION` en el `Dockerfile`).

Lo prueba `npm run smoke:demo-apple` (imagen, preparar, servir, aislamiento y reset) y la
restauración con otro contenedor, `npm run smoke:demo-restaurar`.

## Preparar (una vez)

```bash
docker build -t dotrino-demo-apple dotrino-test/demo-apple
docker volume create demo-apple
docker run --rm -it -v demo-apple:/data dotrino-demo-apple preparar
```

Pide la contraseña del revisor dos veces (12 caracteres o más) y termina con la dirección.
Esa dirección y esa contraseña van en App Store Connect → *App Review Information* →
*Sign-in information*.

Preparar otra vez cambia la dirección: hay que borrar el volumen antes, y actualizar App Store
Connect después.

## Servir

```bash
docker run -d --name demo-apple --restart always \
  --cap-add NET_ADMIN -e DEMO_FIREWALL=1 -e DEMO_RESET_SECONDS=3600 \
  -v demo-apple:/data dotrino-demo-apple
```

| Variable | Qué hace |
|---|---|
| `DEMO_RESET_SECONDS` | el contenedor sale pasado ese tiempo y `--restart` lo levanta desde la copia |
| `DEMO_FIREWALL=1` | solo deja salir hacia el proxio (y el DNS). Necesita `NET_ADMIN`; si no puede aplicarse, no arranca |
| `DEMO_PROXY` | el proxio (por defecto `wss://proxy.dotrino.com`) |
| `DEMO_USER` / `DEMO_MACHINE_NAME` | solo al preparar: el usuario (`apple`) y el nombre de la máquina |

## Dónde corre: Fly.io

App **`dotrino-demo-apple`** (organización `dotrino`, cuenta `sandrade@dotrino.com`), región
`ord`, una Machine `shared-cpu-1x` de 512 MB con el volumen cifrado `demo_data` en `/data`.
La configuración es `fly.toml` de esta carpeta. No expone ningún servicio: la máquina solo sale
al proxio.

Comprobado en la Machine: `iptables` e `ip6tables` funcionan como root, y el resolver es
`fdaa::3` (IPv6), por eso el firewall deja pasar el DNS en las dos familias.

```bash
cd dotrino-test/demo-apple
fly deploy --ha=false --local-only      # una sola Machine: el volumen es uno
```

**Preparar** se hace dentro de la Machine, que sin copia espera en vez de salir:

```bash
fly ssh console --pty -C '/opt/demo/entrypoint.sh preparar' -a dotrino-demo-apple
fly machine restart -a dotrino-demo-apple
```

**Ver que sirve:** `fly logs -a dotrino-demo-apple` tiene que enseñar `firewall on`,
`identified on the proxy` y `agente activo`, y repetirlo cada hora (`DEMO_RESET_SECONDS`).

**Volver a preparar** (cambia la dirección, hay que actualizar App Store Connect). Nunca con
`servir` en marcha, o habría dos bóvedas sobre `/data/run`: primero se borra la copia y se
reinicia, y la Machine se queda esperando.

```bash
fly ssh console -C 'rm -rf /data/copia /data/machine-id' -a dotrino-demo-apple
fly machine restart -a dotrino-demo-apple          # sin copia: espera
fly ssh console --pty -C '/opt/demo/entrypoint.sh preparar' -a dotrino-demo-apple
fly machine restart -a dotrino-demo-apple
```

El volumen guarda snapshots diarios (5 de retención). Contienen la bóveda de la demo, que no
vale nada fuera de ella.
