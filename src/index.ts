import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { exec, spawn } from "node:child_process";
import util from "node:util";
import postgres from "postgres";

const execAsync = util.promisify(exec);

const sql = postgres(process.env.PG_URL);

type ProjectSchema = {
  business_name: string;
  business_logo: string;
  id: string;
  domain: string;
  user_id: string;
  need_publish: boolean;
  build_pid: string;
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
            domain,
            user_id,
            business_name,
            business_logo,
            env,
            build_pid,
            build_last_step,
            build_total_step
      FROM project
      WHERE 
          id = ${projectId}
          AND user_id = ${userId}
      `;

  return project;
}

async function setProjectBuildPID(projectId: string, pid: number | null) {
  await sql`UPDATE project SET build_pid = ${
    pid !== null ? String(pid) : ""
  } WHERE id = ${projectId}`;
}

async function setProjectBuildStep(
  projectId: string,
  lastStep: number,
  totalStep: number
) {
  await sql`UPDATE project SET build_last_step = ${lastStep}, build_total_step = ${totalStep} WHERE id = ${projectId}`;
}

async function killPID(pid: number | null) {
  if (pid === null) {
    return;
  }

  await execAsync(`kill -9 ${pid}`);
}

async function checkPID(pid: number | null) {
  if (pid === null) {
    return;
  }

  const { stdout } = await execAsync(
    `ps -p ${pid} > /dev/null || echo "false"`
  );
  return stdout.trim() === "true";
}

async function clearPID(projectId: string, pid: number | null) {
  await setProjectBuildPID(projectId, pid);
  if (await checkPID(pid)) {
    await killPID(pid);
  }
}

async function buildAndRun(
  projectId: string,
  subDomain: string,
  projectEnv: ProjectSchema["env"]
): Promise<number> {
  const totalSteps = 14;
  let lastStep = 0;

  const tag = `${process.env.DOCKER_REGISTRY}/${subDomain}:latest`;

  const buildExitCode = await new Promise<number | null>((resolve) => {
    const dockerBuild = spawn("docker", [
      "build",
      "--build-arg",
      `BASE_IMAGE=${process.env.DOCKER_BASE_IMAGE}`,
      "--build-arg",
      `PG_URL=${process.env.PG_URL}`,
      "--build-arg",
      `NEXT_PUBLIC_UMAMI_URL=${process.env.NEXT_PUBLIC_UMAMI_URL}`,
      "--build-arg",
      `NEXT_PUBLIC_ICONIFY_API_URL=${process.env.NEXT_PUBLIC_ICONIFY_API_URL}`,
      "--build-arg",
      `NEXT_PUBLIC_UMAMI_ID=${projectEnv.NEXT_PUBLIC_UMAMI_ID}`,
      "--build-arg",
      `PROJECT_ID=${projectId}`,
      "--no-cache",
      "--progress",
      "plain",
      //   "--platform",
      //   "linux/amd64,linux/arm64",
      "-f",
      "Dockerfile.generator",
      "-t",
      tag,
      ".",
    ]);

    const buildPID = dockerBuild.pid || null;
    const catchFn = () => {
      clearPID(projectId, buildPID).finally(() => {
        resolve(1);
      });
    };

    setProjectBuildPID(projectId, buildPID).catch(catchFn);

    dockerBuild.stdout.on("data", (data) => {
      console.log(`dockerBuild:stdout: ${data}`);
    });

    dockerBuild.stderr.on("data", (data) => {
      const stepLine = `${data}`;
      console.log("stepLine: ", stepLine);

      if (stepLine.startsWith("#")) {
        const buildStep = Number(stepLine.split(" ")[0]?.replace("#", ""));
        if (buildStep > lastStep) {
          lastStep = buildStep;
          setProjectBuildStep(projectId, lastStep, totalSteps).catch(catchFn);
        }
      }

      console.error(`dockerBuild:stderr: ${stepLine}`);
    });

    dockerBuild.on("close", (code) => {
      console.log(`dockerBuild:child process exited with code ${code}`);
      resolve(code);
    });
  });

  if (buildExitCode !== 0) {
    return 1;
  }

  const projectLabel = "hooore.project";
  const { stdout, stderr } = await execAsync(
    `docker inspect --format='{{index .Config.Labels "${projectLabel}"}}' ${subDomain} 2>/dev/null || echo "false"`
  );

  try {
    await setProjectBuildStep(projectId, ++lastStep, totalSteps);
  } catch {
    return 1;
  }

  if (stderr) {
    return 1;
  }

  const isDeploymentExist = stdout.trim() === "true";
  console.log(`dockerInspect:stdout: ${stdout}`);
  console.error(`dockerInspect:stderr: ${stderr}`);

  if (isDeploymentExist) {
    const { stdout, stderr } = await execAsync(
      `docker stop ${subDomain} && docker rm ${subDomain}`
    );
    console.log(`dockerStopRm:stdout: ${stdout}`);
    console.error(`dockerStopRm:stderr: ${stderr}`);
  }

  try {
    await setProjectBuildStep(projectId, ++lastStep, totalSteps);
  } catch {
    return 1;
  }

  const runExitCode = await new Promise<number | null>((resolve) => {
    const dockerRun = spawn("docker", ["push", tag]);

    dockerRun.stdout.on("data", (data) => {
      console.log(`dockerRun:stdout: ${data}`);
    });

    dockerRun.stderr.on("data", (data) => {
      console.error(`dockerRun:stderr: ${data}`);
    });

    dockerRun.on("close", (code) => {
      console.log(`dockerRun:child process exited with code ${code}`);
      resolve(code);
    });
  });

  try {
    await setProjectBuildStep(projectId, ++lastStep, totalSteps);
  } catch {
    return 1;
  }

  if (runExitCode !== 0) {
    return 1;
  }

  return 0;
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

  if (project.build_pid !== "") {
    await clearPID(project.id, Number(project.build_pid));
  }

  buildAndRun(project.id, project.domain, project.env).then((res) => {
    if (res === 0) {
      setProjectBuildPID(project.id, null);
    }
  });

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
