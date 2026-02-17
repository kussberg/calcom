import type { NextApiRequest, NextApiResponse } from "next";

import { WEBAPP_URL } from "@calcom/lib/constants";
import { defaultHandler } from "@calcom/lib/server/defaultHandler";
import { defaultResponder } from "@calcom/lib/server/defaultResponder";

import getAppKeysFromSlug from "../../_utils/getAppKeysFromSlug";
import { encodeOAuthState } from "../../_utils/oauth/encodeOAuthState";

const scopes = ["repo"];

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!req.session?.user?.id) {
    return res.status(401).json({ message: "You must be logged in to do this" });
  }

  const { client_id } = await getAppKeysFromSlug("github");

  if (!client_id || typeof client_id !== "string")
    return res.status(400).json({ message: "GitHub client_id missing." });

  const state = encodeOAuthState(req) ?? "";

  const params = new URLSearchParams({
    client_id,
    redirect_uri: `${WEBAPP_URL}/api/integrations/github/callback`,
    scope: scopes.join(" "),
    state,
  });

  return res.status(200).json({
    url: `https://github.com/login/oauth/authorize?${params.toString()}`,
  });
}

export default defaultHandler({
  GET: Promise.resolve({ default: defaultResponder(handler) }),
});
