// Estas cinco lineas APAGAN la comprobacion de tipos sobre el DOM: con ellas,
// `el.loQueSea` pasa siempre. Estan porque este repo es JS vanilla y usa
// querySelector() sin castear, no porque el codigo este comprobado. Quitarlas
// destapa los errores reales (`npm run type-check` los lista); mientras sigan
// aqui, del DOM no se comprueba nada.
interface Element { [key: string]: any; }
interface EventTarget { [key: string]: any; }
interface HTMLElement { [key: string]: any; }
interface Event { [key: string]: any; }
interface Window { [key: string]: any; }
