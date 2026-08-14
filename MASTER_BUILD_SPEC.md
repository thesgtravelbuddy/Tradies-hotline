# MASTER BUILD SPECIFICATION --- AI TRADE INTAKE ASSISTANT

## Product

A mobile-first web application for trades businesses (plumbers,
electricians, handymen, HVAC, appliance repair, etc.) that acts as an
AI-powered front door and first-level troubleshooting assistant.

The AI does **not diagnose** the fault. It gathers useful information
that an experienced tradesperson would want before contacting or
visiting the customer.

Core chain:

CUSTOMER → WEB INTAKE → STRUCTURED REQUEST STATE → SEMANTIC RETRIEVAL →
TRADE KNOWLEDGE → REASONING MODEL → NEXT QUESTION / PHOTO / VIDEO /
SAFETY FLAG / READY → OWNER JOB BRIEF → OWNER TAKES OVER

The differentiator is the **Trade Knowledge Bank + Semantic Retrieval +
Reasoning Model** combination.

## Product Principles

The product is not "ask an AI what is wrong".

It is:

> Tell the AI what is happening, and it asks the questions an
> experienced tradesperson would want answered.

The tradesperson diagnoses. The AI gathers evidence.

The system must use ordinary customer language, retrieve relevant trade
knowledge, ask useful follow-up questions, avoid redundant questions,
request photos/videos when useful, stop when enough information has been
gathered, and produce a concise owner job brief.

## MVP Scope

### Build

-   Mobile-first customer web interface
-   No native iOS/Android app
-   No mandatory customer login
-   Customer request creation
-   Name, phone, email where configured, service address, preferred
    contact method
-   Initial problem description
-   Conversational follow-up
-   Structured request state
-   Knowledge Bank
-   Semantic retrieval
-   Reasoning model
-   Photo collection
-   Video collection
-   Owner dashboard
-   Owner job brief
-   Optional push-to-talk voice
-   Optional audio playback of AI responses
-   Large, obvious play button
-   Text always shown with audio

### Do not build in MVP

-   Native mobile apps
-   Customer account system
-   Calendar
-   Automatic scheduling
-   Travel-time calculations
-   Maps-based scheduling
-   Automatic appointment booking
-   Automatic diagnosis
-   AI image/video diagnosis
-   Automatic pricing or quotations
-   Always-listening microphone
-   Complex WhatsApp/SMS automation
-   Full CRM replacement

## Customer Flow

The customer opens a web link.

Collect: - name - phone - email if enabled - service address - preferred
contact method - problem description

The interface must be extremely simple, mobile-first and suitable for
elderly users: large text, large buttons, high contrast, minimal
clutter, one obvious action at a time, plain language, no app
installation and no account required.

The business owner ultimately contacts the customer directly. Do not
build an elaborate callback system in MVP.

## Request State

Store request state in the database. Never rely on hidden LLM memory.

Possible statuses: - NEW - IN_PROGRESS - WAITING_FOR_CUSTOMER -
READY_FOR_OWNER - OWNER_REVIEW - CONTACTED - COMPLETED - CANCELLED

Customer: - customer_id - name - phone - email -
preferred_contact_method

Job: - request_id - business_id - service_address - trade/category -
original_problem_description - current_summary - status - created_at -
updated_at

Conversation: - message_id - request_id - sender - message_type - text -
timestamp

Structured facts may include: - location_of_problem - when_started -
frequency - what_triggers_problem - what_stops_problem -
affected_equipment - visible_damage - unusual_noise - smell -
water_presence - power_status - previous_attempts - urgency -
safety_information

Media: - media_id - request_id - type - storage_reference -
caption/instruction - timestamp

Types: PHOTO, VIDEO, AUDIO.

## Knowledge Bank

The Knowledge Bank is a first-class product feature and major
differentiator.

It can contain: - PDFs - DOC/DOCX - TXT - Markdown - expert notes -
manufacturer manuals - business procedures - troubleshooting guides -
safety information - recommended questions - decision trees -
evidence/photo requirements - common customer descriptions - trade
terminology - "never tell the customer to do this" rules

The owner can progressively dump large amounts of useful trade
information into the system.

### Knowledge processing

1.  Store original document.
2.  Extract text.
3.  Clean text.
4.  Split into useful chunks.
5.  Add metadata.
6.  Generate embeddings.
7.  Store chunks.
8.  Store vector embeddings.
9.  Preserve source references.

Preferred prototype: - DigitalOcean Spaces (or existing suitable
DigitalOcean storage) for originals. - PostgreSQL for application
data. - pgvector for vector search where practical.

Metadata should support: - business_id - trade - category -
source_document - source_section - topic - safety_level -
active/inactive - version - timestamps

Knowledge must be tenant/business scoped so one business cannot retrieve
another business's private knowledge.

## Semantic Retrieval

Semantic retrieval is essential.

It answers:

> What knowledge is relevant to what the customer just said?

Example knowledge: "Water leaking from toilet base after flushing."

Customer: "Every time I pull the chain, water comes out underneath the
loo."

The wording differs, but the retrieval system should find the relevant
knowledge.

Support: - semantic similarity - metadata filtering - trade filtering -
business filtering - configurable top-K retrieval - source references

Do not send the whole Knowledge Bank to the reasoning model. Retrieve
only relevant chunks.

## Reasoning Engine

The reasoning model is the main intelligence layer.

Inputs: - current customer message - original request - current
structured request state - previous conversation - known facts -
retrieved knowledge - safety rules - business rules - already-collected
media

Conceptual structured output:

``` json
{
  "understanding": "...",
  "updated_facts": {},
  "missing_important_information": [],
  "next_action": "ask_question",
  "question": "...",
  "request_photo": false,
  "request_video": false,
  "safety_flag": false,
  "confidence": "high",
  "ready_for_owner": false
}
```

Use structured outputs where supported.

### Retrieval vs reasoning

Semantic retrieval: \> What knowledge is relevant?

Reasoning: \> Given the customer, request state and relevant knowledge,
what important information is still missing and what should we ask next?

Keep these layers separate.

## Question Selection

Do not create a separate "Question Selector AI" unless testing proves it
is necessary.

The reasoning model should choose the next useful question using
retrieved knowledge.

Knowledge may contain: - recommended questions - decision trees - common
scenarios - important facts - safety rules - evidence requirements

Avoid: - questions already answered - redundant questions - unnecessary
questions - overly technical questions - questions that do not improve
the owner's understanding

Prefer: - one useful question at a time - simple customer-friendly
language - logical progression - stopping when enough information exists

More questions are not automatically better.

## Non-Diagnosis Rule

This is a hard rule.

GOOD: Customer: "My kitchen sink is leaking." AI: "Does it leak all the
time, or mainly when you turn the tap on?"

BAD: "Your waste pipe is leaking."

BAD: "You need to replace the pipe."

The AI gathers information. The tradesperson diagnoses.

The AI must not claim certainty about a fault it has not actually
established.

## Safety

Safety information is especially important for electrical, gas, water
and other potentially dangerous scenarios.

Safety rules should come from the Knowledge Bank plus system-level
safety rules.

If a safety concern appears: - flag it; - use safe, appropriate
language; - do not give dangerous instructions; - make the issue
prominent to the owner.

Trade-specific safety rules should be configurable.

## Photos and Video

Media is evidence collection, not AI diagnosis.

Wide/context: \> Please take one photo from a little further away so we
can see the whole area.

Close-up: \> Now take a closer photo showing where you can see the
water.

Video: \> Please take a short video from further away first, then move
closer and show where the problem is.

Do not build AI image/video diagnosis in MVP.

Store original media securely for the tradesperson.

## Optional Voice

Voice is optional and **push-to-talk only**.

Flow: 1. Press large microphone button. 2. Record. 3. Stop. 4. Press
send. 5. Speech-to-text. 6. Transcript becomes part of request.

No always-listening microphone. No hidden recording.

### AI audio responses

AI responses may optionally have audio.

Always show the text.

Use a **large, obvious play button**, suitable for elderly customers.

Do not make audio mandatory.

## Owner Dashboard

Owner should not need to read the entire conversation.

Show: - new requests - waiting for customer - ready for owner -
contacted - completed

Request detail: - customer - phone/email - address - original problem -
structured facts - AI summary - unanswered/unknown information -
photos - videos - audio/transcripts - safety flags - timestamps -
original conversation

Example:

``` text
NEW JOB — PLUMBING

Customer: John Smith
Phone: xxx
Address: xxx

Problem:
Kitchen sink leaking.

Information collected:
- Leak appears underneath sink
- Occurs when tap is running
- Started yesterday
- Water visible around pipe area
- Customer has not attempted repair

Evidence:
- 2 photos
- 1 short video

Safety:
No safety flag identified.

AI intake limitation:
Source of leak has not been diagnosed.

Preferred contact:
Phone

Status:
READY FOR OWNER
```

The owner then takes over.

## Communication and Scheduling

The MVP is a structured front door and assistant.

CUSTOMER → AI INTAKE → OWNER JOB BRIEF → OWNER CONTACTS CUSTOMER

Do not automatically tell the customer a date/time.

Do not build a calendar.

Do not calculate travel or duration.

The owner remains responsible for diagnosis, price, scheduling,
date/time, duration, travel and final customer communication.

Future integrations may include email, SMS, WhatsApp, CRM and business
phone systems, but they are not required for MVP.

## AI Provider Abstraction

Do not hard-code the application to one model provider.

Candidate providers: - OpenAI - Gemini - DeepSeek - Kimi - other
suitable providers

Use configuration such as:

``` text
AI_PROVIDER=...
AI_MODEL=...
```

The retrieval architecture must not need rewriting when the model
changes.

## Model Benchmarking

Do not select a model purely by token price.

Benchmark candidates on identical realistic trade scenarios.

Measure: 1. understanding of normal customer language 2. question
quality 3. unnecessary questions 4. knowledge adherence 5. safety
behaviour 6. non-diagnosis behaviour 7. owner summary quality 8.
structured output reliability 9. latency 10. cost per completed intake

The winning model is the best useful quality for the lowest practical
cost.

## Test Scenarios

Minimum set:

### Plumbing

-   toilet leak
-   sink leak
-   tap leak
-   blocked sink
-   water from unknown location

### Electrical

-   one room without power
-   appliance-related electrical issue
-   light not working
-   tripping breaker
-   ambiguous electrical complaint

Each scenario should test retrieval, reasoning, question selection,
safety, stopping behaviour and owner summary.

Expand the test set as the Knowledge Bank grows.

## Cost Architecture

Per request, possible costs: - LLM input tokens - LLM output tokens -
embeddings - speech-to-text - text-to-speech - storage - media
storage/bandwidth - database/infrastructure

Minimise cost by: - retrieving only relevant knowledge; - not sending
the entire Knowledge Bank; - maintaining structured request state; -
avoiding unnecessary model calls; - tracking usage.

The system should eventually report/estimate cost per completed intake.

## Infrastructure

Preferred prototype:

``` text
Customer Browser
      |
      v
Web Frontend
      |
      v
Backend/API
      |
      +---- PostgreSQL
      |
      +---- pgvector
      |
      +---- DigitalOcean Storage
      |
      +---- AI Provider
      |
      +---- Secure Media Storage
      |
      v
Owner Dashboard
```

Use existing DigitalOcean resources where practical.

Do not add infrastructure without a clear reason.

## Security

Never expose to the browser: - API keys - database passwords - private
storage credentials - secret tokens

Use environment variables.

Never commit real `.env` secrets.

`.env.example` may contain placeholders.

Customer data must remain private.

Media should not be public by default.

Unauthenticated customer links, if used, must use secure random
identifiers/tokens.

## No Native App

Do not build an iOS or Android app.

Reasons: - no installation friction - no app-store approval - lower
maintenance - instant web-link access - lower cost - easier updates

The responsive website should feel app-like on mobile.

## Development Phases

### PHASE 1 --- APPLICATION FOUNDATION

Build: - mobile customer interface - backend/API - PostgreSQL - customer
model - request model - request state - contact fields - initial problem
description - conversation storage - owner dashboard shell - request
list - request detail

Prove a customer can submit a request and an owner can view it.

### PHASE 2 --- KNOWLEDGE BANK

Build: - document upload - original storage - extraction - chunking -
metadata - embeddings - vector storage - retrieval - admin knowledge
management

Test that ordinary customer wording retrieves relevant knowledge.

### PHASE 3 --- REASONING ENGINE

Connect: CUSTOMER MESSAGE + REQUEST STATE + PREVIOUS ANSWERS + RETRIEVED
KNOWLEDGE + SAFETY/BUSINESS RULES → REASONING MODEL

Test understanding, question quality, non-diagnosis, safety and
stopping.

### PHASE 4 --- PHOTO/VIDEO

Add capture/upload, secure storage and AI evidence requests.

No AI media diagnosis.

### PHASE 5 --- VOICE

Add push-to-talk, speech-to-text, transcript, optional text-to-speech,
large play button and visible text.

### PHASE 6 --- OWNER JOB BRIEF

Polish summary, facts, limitations, media, safety flags, contact details
and original request.

### PHASE 7 --- MODEL BENCHMARKING

Run identical scenarios through candidate models and compare
quality/cost.

## Coding-Agent Rules

The coding agent must: 1. Read this specification completely before
coding. 2. Inspect the repository first. 3. Inspect existing
DigitalOcean resources where accessible. 4. Reuse suitable
infrastructure. 5. Avoid unnecessary dependencies. 6. Keep modules
separated. 7. Keep AI provider abstraction separate. 8. Keep retrieval
independent from the reasoning provider. 9. Store request state in the
database. 10. Never rely on hidden model memory for critical state. 11.
Never commit secrets. 12. Never build native apps unless explicitly
instructed. 13. Never add calendar/scheduling unless explicitly
instructed. 14. Never implement automatic diagnosis. 15. Never implement
AI image/video diagnosis unless explicitly instructed. 16. Never turn
this into a generic chatbot. 17. Write and run tests. 18. Build one
phase at a time. 19. Audit each phase before starting the next. 20. Do
not silently change core product decisions.

## Phase Completion Rule

After every phase: 1. Run automated tests. 2. Run manual acceptance
tests. 3. Report what works. 4. Report what is missing. 5. Identify
technical risks. 6. Fix failures. 7. Only then start the next phase.

Files existing does not mean a phase is complete.

## Core Acceptance Criteria

A successful prototype demonstrates: 1. Customer can describe a problem
naturally. 2. Relevant trade knowledge can be retrieved despite
different wording. 3. Reasoning model uses retrieved knowledge. 4. AI
asks useful questions. 5. AI does not pretend to diagnose. 6. AI avoids
redundant questions. 7. AI can request useful photos/videos. 8. Optional
voice input works. 9. Owner receives a concise useful brief. 10. Owner
can access original evidence. 11. Customer data is private. 12. AI
provider can be swapped. 13. Cost per completed intake can eventually be
measured. 14. A normal customer can use the system without training.

## Product Success Test

The ultimate test is not:

> Does the AI sound intelligent?

It is:

> Does the tradesperson say: "This gives me useful information I would
> normally have to spend time asking the customer for"?

If yes, the product is doing its job.

## Long-Term Vision

Potential future capabilities: - multiple trades - multiple businesses -
business-specific knowledge - email/SMS/WhatsApp integration - CRM
integration - quote preparation support - job categorisation - urgency
prioritisation - analytics - intake quality scoring - scheduling
integration - customer history

These are future possibilities and must not distract from proving the
core intake proposition.

## Final Architecture

``` text
CUSTOMER
    |
    v
MOBILE WEB INTAKE
    |
    v
STRUCTURED REQUEST STATE
    |
    v
SEMANTIC RETRIEVAL
    |
    v
TRADE KNOWLEDGE
    |
    v
REASONING MODEL
    |
    +----> ASK QUESTION
    |
    +----> REQUEST PHOTO
    |
    +----> REQUEST VIDEO
    |
    +----> SAFETY FLAG
    |
    +----> READY FOR OWNER
                  |
                  v
           OWNER JOB BRIEF
                  |
                  v
           OWNER TAKES OVER
```

**Knowledge Bank = domain knowledge.**

**Semantic retrieval = finds the relevant knowledge.**

**Reasoning model = decides what information is still missing.**

**Customer = supplies the information.**

**System = structures the information.**

**Tradesperson = diagnoses and makes the final decision.**

That separation is fundamental to the product.
