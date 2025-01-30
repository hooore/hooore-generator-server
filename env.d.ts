declare namespace NodeJS {
  interface ProcessEnv {
    HOSTNAME: string;
    PORT: string;
    PG_URL: string;
    GENERATOR_SERVER_TOKEN: string;
    MAIN_HOST_DOMAIN: string;
    COOLIFY_BASE_URL: string;
    COOLIFY_API_TOKEN: string;
    COOLIFY_SERVER_UUID: string;
    COOLIFY_PROJECT_UUID: string;
    COOLIFY_PROJECT_ENVIRONMENT_NAME: string;
    APP_PG_URL: string;
    APP_NEXT_PUBLIC_UMAMI_URL: string;
    APP_NEXT_PUBLIC_ICONIFY_API_URL: string;
    APP_DOCKER_REGISTRY: string;
    APP_DOCKER_BASE_IMAGE: string;
  }
}
