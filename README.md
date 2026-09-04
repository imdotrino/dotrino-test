# test.dotrino.com — banco de pruebas del ecosistema

Dos cosas distintas viven en este repo:

1. **La página** (`index.html` + `src/`): un sandbox para comprobar en un
   teléfono real cosas que solo se ven ahí — sobre todo **qué pasa al abrir un
   enlace desde dentro de una PWA** (¿navegador completo o *Custom Tab*?).
2. **Los smokes** (`smoke/`): pruebas de extremo a extremo que levantan cada
   pieza del ecosistema **en su propio contenedor** y las hacen hablar entre sí.

## La página NO es una PWA, y es a propósito

No lleva `manifest.webmanifest`, y su `sw.js` es el **autodestructivo**: borra
las cachés de la versión anterior, se desregistra y recarga. Si le pusieras un
manifest perdería su razón de ser, que es precisamente medir el comportamiento
*fuera* de una app instalada. Está declarado como desvío en el índice del
ecosistema, no es un olvido.

Lo demás sí lo cumple: `<dotrino-topbar>` con botón de perfil (§5, §6.1),
bilingüe es/en (§9) y `noindex` + `robots` en `Disallow: /` por ser interna (§7).

## Los smokes

```sh
npm run smoke                 # todo
npm run smoke:dispositivos    # cada aparato en su contenedor, contra el binario
npm run smoke:configuracion   # proxio ↔ bóveda, de caja negra
npm run smoke:navegador       # con Playwright (incluye el PERFIL EN SOBRES, de punta a punta)
npm run smoke:consola
npm run smoke:tui
npm run smoke:interfaz
```

Cada uno arranca lo que necesita y lo apaga al terminar.

## Desarrollo

```sh
npm install
npm run dev        # http://localhost:3130
npm run build      # → dist/
npm run type-check
```

## Deploy

GitHub Actions construye `dist/` y lo publica en Pages bajo
**`https://test.dotrino.com/`** (`.github/workflows/deploy.yml`).

## Licencia

MIT — © Dotrino
