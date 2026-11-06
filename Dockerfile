
# Stage 1: Build backend
FROM node:24-alpine AS build

WORKDIR /app

# Copy dependency files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy Prisma schema and configuration
COPY prisma ./prisma
COPY prisma.config.ts ./

# Copy source code
COPY tsconfig*.json ./
COPY nest-cli.json ./
COPY src ./src

# Prisma config may require DATABASE_URL during generation.
ARG DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/attendance_db"

ENV DATABASE_URL=${DATABASE_URL}

# Generate Prisma Client
RUN npx prisma generate

# Build NestJS
RUN npm run build


# Stage 2: Production
FROM node:24-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

# Copy package files
COPY package*.json ./

# Install production dependencies
RUN npm ci --omit=dev

# Copy compiled application
COPY --from=build /app/dist ./dist

# Copy generated Prisma client
COPY --from=build /app/src/generated/prisma ./src/generated/prisma

# Copy Prisma configuration and schema
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts ./

EXPOSE 3000

CMD ["node", "dist/main.js"]
