declare namespace NodeJS {
  interface ProcessEnv {
    HOSTNAME: string;
    PORT: string;
    PG_URL: string;
    GENERATOR_SERVER_TOKEN: string;
    NEXT_PUBLIC_UMAMI_URL: string;
    NEXT_PUBLIC_ICONIFY_API_URL: string;
    DOCKER_REGISTRY: string;
    DOCKER_BASE_IMAGE: string;
  }
}
