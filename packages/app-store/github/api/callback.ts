import type { NextApiRequest, NextApiResponse } from "next";

import { WEBAPP_URL } from "@calcom/lib/constants";
import { getSafeRedirectUrl } from "@calcom/lib/getSafeRedirectUrl";
import { HttpError } from "@calcom/lib/http-error";
import { defaultHandler } from "@calcom/lib/server/defaultHandler";
import { defaultResponder } from "@calcom/lib/server/defaultResponder";

import getAppKeysFromSlug from "../../_utils/getAppKeysFromSlug";
import getInstalledAppPath from "../../_utils/getInstalledAppPath";
import createOAuthAppCredential from "../../_utils/oauth/createOAuthAppCredential";
import { decodeOAuthState } from "../../_utils/oauth/decodeOAuthState";
import appConfig from "../config.json";

async function getHandler(req: NextApiRequest, res: NextApiResponse) {
  const { code } = req.query;

  const state = decodeOAuthState(req);

  const redirectAfterSuccess =
    getSafeRedirectUrl(state?.returnTo) ??
    getInstalledAppPath({ variant: appConfig.variant, slug: appConfig.slug });
  const redirectAfterSuccessOrError = getSafeRedirectUrl(state?.onErrorReturnTo) ?? redirectAfterSuccess;

  if (!code || typeof code !== "string") {
    if (state?.onErrorReturnTo || state?.returnTo) {
      res.redirect(redirectAfterSuccessOrError);
      return;
    }
    throw new HttpError({ statusCode: 400, message: "`code` must be a string" });
  }

  if (!req.session?.user?.id) {
    throw new HttpError({ statusCode: 401, message: "You must be logged in to do this" });
  }

  const { client_id, client_secret } = await getAppKeysFromSlug("github");

  if (!client_id || typeof client_id !== "string")
    return res.status(400).json({ message: "GitHub client_id missing." });
  if (!client_secret || typeof client_secret !== "string")
    return res.status(400).json({ message: "GitHub client_secret missing." });

  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id,
      client_secret,
      code,
      redirect_uri: `${WEBAPP_URL}/api/integrations/github/callback`,
    }),
  });

  if (!response.ok) {
    return res.redirect(`${redirectAfterSuccessOrError}?error=Error getting GitHub access token`);
  }

  const responseJson = await response.json();

  if (responseJson.error) {
    return res.redirect(
      `${redirectAfterSuccessOrError}?error=${responseJson.error_description || responseJson.error}`
    );
  }

  const { access_token, token_type } = responseJson;

  await createOAuthAppCredential(
    { appId: appConfig.slug, type: appConfig.type },
    { access_token, token_type },
    req
  );

  return res.redirect(redirectAfterSuccess);
}

export default defaultHandler({
  GET: Promise.resolve({ default: defaultResponder(getHandler) }),
});
