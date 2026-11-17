# Dotrino Remote Desktop

> **Parte del ecosistema [Dotrino](https://dotrino.com).**

El escritorio de tu computadora, desde el navegador de otro aparato de tu cuenta. No transmite
píxeles: transmite el **árbol de accesibilidad** del escritorio (ventanas, botones, menús,
textos, con su posición; lo mismo que leen los lectores de pantalla) y después solo lo que
cambia. El navegador lo dibuja en SVG. Solo entran los aparatos que tu **acta** reconoce con
permiso `sign`, y todo viaja cifrado de punta a punta. No hay puertos abiertos ni contraseñas.

**Cómo se usa:** en el wiki, [escritorio remoto](https://wiki.dotrino.com/herramientas/escritorio-remoto/).

```
 navegador (aparato de la cuenta)              máquina (sesión gráfica)
 ┌───────────────────────────────┐            ┌────────────────────────────────┐
 │ remote-desktop.dotrino.com     │            │ @dotrino/remote-desktop-agent   │
 │ RemoteAgentClient + SVG        │            │ startRemoteAgent + AT-SPI       │
 └──────────────┬────────────────┘            └──────────────┬─────────────────┘
                └──── proxy.dotrino.com · sesión cifrada ─────┘
          las dos puntas se juzgan contra el ACTA de la cuenta
```

## Por qué así

| | Píxeles (VNC) | Vídeo | **Accesibilidad (esto)** |
|---|---|---|---|
| Una ventana entera | 150–300 KB | flujo continuo | **~4 KB** comprimidos |
| Un cambio | el rectángulo entero | cuadros | **bytes** (`este campo dice X`) |
| Texto | borroso al moverse | borroso en color | **exacto** |
| Lo que es imagen | sí | sí | **vídeo de ese rectángulo** (solo si cambia; reducido por el proxio) |

Medido el 2026-11-16 en un XFCE con dos monitores: la escena entera son 525 nodos (57 KB de JSON)
y los cambios, de 0,3 a 2 KB.

**Los huecos llevan vídeo** (agente ≥ 0.3.0): de la ventana que se mira, ella entera si no publica nada o
su hueco más grande. `ffmpeg` captura solo ese rectángulo (x11grab → H.264 baseline) y descarta los cuadros
iguales antes de codificar: una ventana quieta no manda nada. El navegador lo decodifica con WebCodecs.
**El vídeo según el camino:** por WebRTC directo, socket local o Bluetooth, a calidad completa (15 cuadros/s);
por el proxio o el TURN de Dotrino, muy conservador (un cuarto de los píxeles, 3 cuadros/s, ~150 kbps;
medido: ~16 KB/s contra ~53 KB/s del directo con la misma ventana en movimiento).

**El límite, dicho:** lo que no publica accesibilidad no se ve por dentro. Las apps GTK la publican
siempre. Chrome, VS Code, Slack y demás Electron solo si arrancan con la accesibilidad encendida (el
agente la enciende mientras alguien mira, así que las que se abran desde entonces sí; las que ya
estaban abiertas hay que reiniciarlas una vez). Un lienzo, una foto, un vídeo o un juego salen como
hueco con su nombre.

## Qué reusa

- **[`@dotrino/remote-agent`](https://github.com/imdotrino/dotrino-remote-agent)**: enlace con la
  bóveda (`enrollInteractive`), saludo contra el acta, sesión cifrada, revocación, renovación del
  papel, bitácora y autoactualización (`/update`).
- **[`@dotrino/proxy-client`](https://github.com/imdotrino/dotrino-proxy-client)**: el transporte, que
  además trocea lo grande (`parts`, ≥ 0.49.0) y el cliente D-Bus con el que se lee AT-SPI (`/dbus`).

## Protocolo

| Sentido | Payload |
|---|---|
| cliente → máquina | `scene` · `leave` · `raise {id}` (traer la ventana al frente; X11 con `xdotool`) · `click {x,y,button?,double?}` · `press`/`release {x,y,button?}` · `move {x,y}` · `wheel {x,y,dy}` · `action {id,index?}` · `focus {id}` · `text {text}` · `key {keysym}` · `video {id\|null}` |
| máquina → cliente | `scene {seq,screen,wins,nodes}` · `patch {seq,base,put,del,order?,screen?,wins?}` · `vframe {id,seq,key,rect,q,data}` · `fail {code,message}` |

Un nodo: `{id, p (padre), r (rol), n (nombre), t (texto), x, y, w, h, s (estados en letras), a (acciones), hole?}`.
Un `patch` cuyo `base` no es la escena del cliente se rechaza (`stale`) y el cliente pide la escena
entera: no se pinta a medias. La lógica de diferencias (`agent/scene.js`) es la misma en las dos
puntas.

## Estructura

- **`index.html` + `src/`** — la PWA (Vite). `/` la portada; `/desktops` tus escritorios. `?demo`
  enseña una escena de ejemplo sin red ni perfil.
- **`agent/`** — `@dotrino/remote-desktop-agent` (Node, Linux): `atspi.js` lee el escritorio y
  genera ratón y teclado por AT-SPI; `desktop.js` relee solo las ventanas que cambian (eventos de
  accesibilidad + la lista de ventanas cada segundo); `scene.js` las diferencias; `index.js` la sesión.

## Desarrollo

```sh
npm install && npm run dev           # la PWA (http://localhost:3410/desktops?demo)
npm run type-check

cd agent && npm install && npm test  # el agente
node bin/cli.js                      # enlaza (pide la invitación de `dotrino-vault pair`) y corre
```

El agente corre **dentro de la sesión gráfica** del usuario: necesita su bus de sesión y el de
accesibilidad (`at-spi2-core`).

## Publicar

Desde CI, nunca a mano: tag `agent-vX.Y.Z` → `release.yml` publica `@dotrino/remote-desktop-agent`
con procedencia, SBOM y `npm-integrity.json`. La PWA se despliega con cada push a `main`.

MIT.
