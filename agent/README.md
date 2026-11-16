# @dotrino/remote-desktop-agent

> **Parte del ecosistema [Dotrino](https://dotrino.com).**

El agente de [Dotrino Remote Desktop](https://remote-desktop.dotrino.com/): deja usar el escritorio
de esta máquina (Linux, X11 o Wayland) desde el navegador de otro aparato de tu cuenta. No manda
píxeles: manda el **árbol de accesibilidad** del escritorio (AT-SPI) y luego solo lo que cambia.
Solo entran los aparatos que tu acta reconoce, y todo va cifrado de punta a punta.

**Cómo se usa:** [wiki.dotrino.com/herramientas/escritorio-remoto](https://wiki.dotrino.com/herramientas/escritorio-remoto/).

```sh
npm install -g @dotrino/remote-desktop-agent
dotrino-remote-desktop-agent          # enlaza con tu bóveda la primera vez y corre
dotrino-remote-desktop-agent info     # qué aparato es (su ID)
dotrino-remote-desktop-agent update   # cómo se actualiza (§15)
```

Corre dentro de la sesión gráfica del usuario: necesita su bus de sesión y el de accesibilidad
(`at-spi2-core`). Protocolo y diseño: [el repo](https://github.com/imdotrino/dotrino-remote-desktop).

MIT.
