import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import process from "node:process";
import postgres from "postgres";

const sql = postgres(process.env.PG_URL);

type ProjectSchema = {
  business_name_slug: string;
  business_name: string;
  business_logo: string;
  id: string;
  user_id: string;
  need_publish: boolean;
  app_id: string;
  build_last_step: number;
  build_total_step: number;
  env: {
    NEXT_PUBLIC_UMAMI_ID?: string | undefined;
  };
};

type Body = {
  userId: string;
};

async function getProject(projectId: string, userId: string) {
  const [project] = await sql<[ProjectSchema?]>`
      SELECT
            id,
            user_id,
            business_name,
            business_name_slug,
            business_logo,
            env,
            app_id,
            build_last_step,
            build_total_step
      FROM project
      WHERE 
          id = ${projectId}
          AND user_id = ${userId}
      `;

  return project;
}

async function setProjectAppID(projectId: string, appId: string) {
  await sql`UPDATE project SET app_id = ${appId} WHERE id = ${projectId}`;
}

async function setProjectBuildStep(
  projectId: string,
  lastStep: number,
  totalStep: number
) {
  await sql`UPDATE project SET build_last_step = ${lastStep}, build_total_step = ${totalStep} WHERE id = ${projectId}`;
}

async function createApp(
  projectId: string,
  subDomain: string,
  projectEnv: ProjectSchema["env"]
): Promise<string> {
  const dockerfile = `
FROM ${process.env.APP_DOCKER_BASE_IMAGE} AS installer
ENV PG_URL=${process.env.APP_PG_URL}
ENV PROJECT_ID=${projectId}
ENV NEXT_PUBLIC_UMAMI_ID=${projectEnv.NEXT_PUBLIC_UMAMI_ID}
ENV NEXT_PUBLIC_UMAMI_URL=${process.env.APP_NEXT_PUBLIC_UMAMI_URL}
ENV NEXT_PUBLIC_ICONIFY_API_URL=${process.env.APP_NEXT_PUBLIC_ICONIFY_API_URL}
RUN pnpm run build
FROM nginx:1.27.0 AS runner
WORKDIR /app
COPY --from=installer /app/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=installer /app/out /var/www/out`;

  const res = await fetch(
    `${process.env.COOLIFY_BASE_URL}/api/v1/applications/dockerfile`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.COOLIFY_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: subDomain,
        domains: `https://${subDomain}.${process.env.MAIN_HOST_DOMAIN}`,
        server_uuid: process.env.COOLIFY_SERVER_UUID,
        project_uuid: process.env.COOLIFY_PROJECT_UUID,
        environment_name: process.env.COOLIFY_PROJECT_ENVIRONMENT_NAME,
        dockerfile: Buffer.from(dockerfile).toString("base64"),
      }),
    }
  );

  const resJson = (await res.json()) as { uuid: string };
  return resJson.uuid;
}

async function deployApp(appId: string): Promise<void> {
  await fetch(
    `${process.env.COOLIFY_BASE_URL}/api/v1/deploy?uuid=${appId}&force=true`,
    {
      headers: {
        Authorization: `Bearer ${process.env.COOLIFY_API_TOKEN}`,
      },
    }
  );
}

async function getAppDeployment(appId: string) {
  const res = await fetch(
    `${process.env.COOLIFY_BASE_URL}/api/v1/deployments`,
    {
      headers: {
        Authorization: `Bearer ${process.env.COOLIFY_API_TOKEN}`,
      },
    }
  );

  const resJson = (await res.json()) as {
    deployment_url: string;
    deployment_uuid: string;
    logs: string;
  }[];

  return resJson.find((d) => d.deployment_url.includes(appId));
}

async function watchDeploymentLog(deploymentUUID: string) {
  const res = await fetch(
    `${process.env.COOLIFY_BASE_URL}/api/v1/deployments/${deploymentUUID}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.COOLIFY_API_TOKEN}`,
      },
    }
  );

  return (await res.json()) as {
    logs: string;
    status: string;
  };
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const app = new Hono();

app.use(cors());

app.get("/", async () => {
  return new Response(JSON.stringify({ hello: "world." }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
    },
  });
});

app.post("/api/publish/:projectId", async (c) => {
  if (c.req.header("X-Auth-Key") !== process.env.GENERATOR_SERVER_TOKEN) {
    return new Response(JSON.stringify({ message: "Unauthenticated." }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  const projectId = c.req.param("projectId");
  const requestBody = await c.req.json<Body>();
  const project = await getProject(projectId, requestBody.userId);

  if (!project) {
    return new Response(JSON.stringify({ message: "Not found." }), {
      status: 404,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  let appId = project.app_id;
  if (appId !== "") {
    await deployApp(appId);
  } else {
    appId = await createApp(
      project.id,
      project.business_name_slug,
      project.env
    );
    await setProjectAppID(project.id, appId);
    await deployApp(appId);
  }

  const deployment = await getAppDeployment(appId);
  if (deployment) {
    let step = 1;
    const totalSteps = 12;

    (async function inProgress() {
      const deploymentLog = await watchDeploymentLog(
        deployment.deployment_uuid
      );
      const logs = JSON.parse(deploymentLog.logs) as {
        output: string;
      }[];
      const lastLog = logs
        ?.findLast((log) => log.output.startsWith("#"))
        ?.output.split("\n")
        .findLast((log) => log.startsWith("#"));
      step = Number(lastLog?.split(" ")[0]?.replace("#", ""));
      console.log("step", step);
      console.log("lastLog", lastLog);
      if (step) {
        await setProjectBuildStep(project.id, step, totalSteps);
      }
      if (deploymentLog.status !== "finished") {
        await sleep(5 * 1000);
        inProgress();
      }
    })();
  }

  return new Response(JSON.stringify({ message: "Success." }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
    },
  });
});

const port = Number(process.env.PORT);
console.log(`Server is running on port ${port}`);

serve({
  fetch: app.fetch,
  port,
});
