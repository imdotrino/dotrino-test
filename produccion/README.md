# Pruebas que SÍ tocan producción

Todo lo demás de este repo corre en local: proxio, bóveda y páginas se levantan aquí y no
sale nada a la red. Lo de esta carpeta es la excepción, y por eso está aparte y **no entra
en `npm run smoke`**.

Se toca producción solo cuando no hay otra forma. Cada prueba dice arriba qué toca y con
qué, y ninguna usa una identidad de verdad: se estrenan llaves de usar y tirar en un
perfil de navegador nuevo que se borra al acabar.

| | Qué prueba | Por qué no puede ser local |
|---|---|---|
| `npm run prod:timbre` | que el proxio despierte por Web Push a una bóveda apagada, y que la cola baje al volver | hace falta un servicio de push de verdad al que el navegador esté conectado |
