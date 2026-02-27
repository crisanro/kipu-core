# Usamos una imagen ligera de Node
FROM node:18-alpine

# Directorio de trabajo
WORKDIR /usr/src/app

# Copiar package.json e instalar dependencias
COPY package*.json ./
RUN npm install --production

# Copiar el código fuente
COPY . .

# Exponer el puerto
EXPOSE 3000

# Comando de inicio
CMD ["node", "src/app.js"]