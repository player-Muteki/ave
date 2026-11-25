import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { EditorService } from "./service.js";
import type { EditorCaller } from "./authorization.js";
import type { EditorPrincipal } from "#video-editor/contracts/v1";

const owner: EditorPrincipal = { principalId: "owner", role: "owner", projectIds: null };
const caller: EditorCaller = { principalId: "owner", permissions: [], editorPrincipal: owner };

it("advertises the device channel and lists owner projects over RPC", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "video-rpc-"));
  const editor = await EditorService.create({ paseoHome: home });
  try {
    await editor.start();
    const caps = (await editor.rpc.invoke("video.v1.get_capabilities", {}, caller)) as {
      features: string[];
      operations: string[];
    };
    expect(caps.features).toContain("device-channel");
    expect(caps.operations).toContain("list-projects");
    expect(await editor.rpc.invoke("video.v1.list_projects", {}, caller)).toEqual({ projects: [] });
    const created = (await editor.rpc.invoke(
      "video.v1.create_project",
      { requestId: "p1", title: "A" },
      caller,
    )) as { projectId: string; revision: string };
    expect(await editor.rpc.invoke("video.v1.list_projects", {}, caller)).toEqual({
      projects: [{ projectId: created.projectId, title: "A", revision: created.revision }],
    });
  } finally {
    await editor.stop();
    await rm(home, { recursive: true, force: true });
  }
});