# Upgrade guide: Supply recognized, complete inline images

Target version: next

## Affected users

Clients sending unknown binary, header-only or truncated bytes as images to Chat,
Responses, Messages, native Gemini or image generation/editing receive an earlier
HTTP 400. Recognized complete PNG, JPEG, GIF, WebP and BMP images continue to work.
Other media families and ordinary file uploads retain their existing policies.

Users of the earlier controlled image history window should review its settings.
Count and memory are now separate strategies; existing configuration defaults to count.
Current images consume count slots but are all protected when they exceed N. Remote
images only join history count selection when enabled; memory keeps remote URLs.

## Required action

1. Send the original complete image with canonical Base64, or a valid multipart image.
2. For an unsupported format, export it to a recognized image format before resending.
3. Keep tool arguments and image examples as ordinary text when they are not media input.
4. In Settings → Proxy, choose count or decoded-file bytes explicitly. Choose memory
   if you need a soft decoded-file budget; count no longer applies that separate budget.

No configuration migration or application shutdown is required for this admission change.

## Data and recovery

Admission does not migrate or delete retained media or modify account data. The related
[Responses tool-media change](responses-tool-media.md) adds private text references with
separate downgrade requirements. A rejected image does not acquire an account lease or start an upstream
generation. Correct the image and explicitly resend the request. A private media object
that has actually expired or disappeared still requires the original to be resent.
Concurrent cold reads now wait for the same index initialization instead of incorrectly
reporting retained media as missing.

## Downgrade

Admission and cold-index initialization require no storage restoration. Follow the related
tool-media guide before downgrading histories with new version-2 references. Older versions lack these admission and concurrent cold-read protections and
may combine count and memory. Disable the optional window before downgrading if that earlier
selection behavior is unsuitable. The additional strategy key needs no data conversion.

## Verification

The owning [media reference](../../modules/proxy-gateway/inline-media-and-thought-history.md)
describes the limits. Controlled checks exercise rejected protocol inputs, real Fastify
multipart requests, and disk-backed Responses/private-media close/reopen with original bytes
in the mapped generation send. See the [decision record](../../../.agents/notes/implemented/bug-fix/2026-10-10-inline-media-thought-capture.md).
These checks use synthetic profiles and substituted upstreams; installed clients, codec
decoding and live-provider image understanding remain unverified for this change.
