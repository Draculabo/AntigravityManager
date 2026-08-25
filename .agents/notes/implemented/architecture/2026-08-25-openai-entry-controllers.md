# Agent Note: OpenAI protocol entry controllers delegate to shared operations

Status: implemented

## Problem

One 883-line `OpenAIController` owned unrelated HTTP entry points for model discovery, chat, Responses, image, and audio requests. Adding or reviewing a route required navigating protocol behavior outside the endpoint's owning surface, and the class name continued to imply it directly registered all routes.

## Decision

The OpenAI module registers dedicated controllers for model, chat, Responses, and media route groups. Each applies the existing proxy guard and delegates to `OpenAIOperations`, the internal provider that retains the established request transformation, streaming, error, persistence, and media logic.

## Alternatives considered

- Move each operation implementation into its new controller. Rejected because duplicating or moving interdependent protocol behavior in the same change would increase compatibility risk.
- Leave the large decorated controller in place and add façade controllers. Rejected because duplicate route decorators would risk ambiguous route registration and retain misleading ownership.

## Consequences

HTTP route ownership is visible from the controller names and files, while shared operation behavior has one implementation. Future endpoint-specific refactors can extract operations incrementally without changing the public route surface. `OpenAIOperations` is internal to the OpenAI module and is not exported as a cross-module API.

## Verification

- The real Nest module resolves every entry controller and `OpenAIOperations`.
- Gateway route census and the dedicated OpenAI route contract assert the complete existing `/v1` OpenAI endpoint set.
- Existing OpenAI controller, durability, streaming, file-reference, and endpoint-coverage tests preserve protocol outputs and error behavior.
