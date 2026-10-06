# LA DEMO DE TERMINAL PARA LA REVISIÓN DE APPLE: una bóveda y una máquina en un contenedor.
#
# Dos usuarios: `vault` corre la bóveda (su directorio es 0700) y `tester` corre el agente y
# las shells. El revisor tiene una shell de `tester` y no puede leer la bóveda. Detalle y
# uso en README.md.

FROM node:22-bookworm-slim AS build
# `node-pty` es nativo y se compila aquí; la imagen final no lleva compilador.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/demo
ARG VAULTD_VERSION=0.141.1
ARG AGENT_VERSION=0.15.0
RUN npm init -y >/dev/null \
 && npm install --no-fund --no-audit --save-exact \
      @dotrino/vaultd@${VAULTD_VERSION} @dotrino/terminal-agent@${AGENT_VERSION}

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends tini iptables bash procps less nano \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /opt/demo /opt/demo
# Sin binarios setuid/setgid: es lo primero que se prueba para pasar de `tester` a root.
RUN find / -xdev -perm /6000 -type f -exec chmod a-s {} + \
 && userdel -r node \
 && useradd --system --uid 1001 --user-group --home-dir /nonexistent --shell /usr/sbin/nologin vault \
 && useradd --uid 1002 --user-group --home-dir /data/run/home --no-create-home --shell /bin/bash tester
ENV PATH=/opt/demo/node_modules/.bin:$PATH
COPY entrypoint.sh enlazar.mjs /opt/demo/
VOLUME /data
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/demo/entrypoint.sh"]
CMD ["servir"]
