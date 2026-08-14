export const actionSet = new Set(['ask_question', 'request_photo', 'request_video', 'complete']);
export function validateDecision(value) { if (!value || !actionSet.has(value.next_action) || typeof value.understanding !== 'string' || !value.updated_facts || !Array.isArray(value.missing_important_information) || typeof value.safety_flag !== 'boolean' || !['low', 'medium', 'high'].includes(value.confidence) || typeof value.ready_for_owner !== 'boolean') throw new Error('Model returned invalid structured intake decision'); return value; }
export class RuleBasedIntakeProvider {
  async decide(context) {
    const text = context.customerMessage.toLowerCase(); const safety = /(sparks?|burning|smell of gas|electric shock|smoke|exposed live)/.test(text);
    const asked = context.requestState.asked ?? []; const facts = {};
    if (/(when|every time|only when|all the time)/.test(text)) facts.whenItOccurs = context.customerMessage;
    if (/(today|yesterday|week|month|just started)/.test(text)) facts.whenStarted = context.customerMessage;
    if (safety) return { understanding: 'The customer has reported a possible safety concern.', updated_facts: facts, missing_important_information: ['whether the area is currently safe'], next_action: 'ask_question', question: 'For safety, please keep clear of the area. Is there any immediate danger such as smoke, sparks, a burning smell, or water near electricity?', request_photo: false, request_video: false, safety_flag: true, confidence: 'high', ready_for_owner: true };
    const options = [
      ['when_it_happens', 'When do you notice the problem — all the time, or only when something is being used?'],
      ['when_started', 'When did you first notice it?'],
      ['location', 'Where exactly are you seeing the issue?'],
      ['previous_attempts', 'Has anyone tried anything to fix it already?']
    ]; const answeredNow = new Set(); if (/(when|every time|only when|all the time)/.test(text)) answeredNow.add('when_it_happens'); if (/(today|yesterday|week|month|just started)/.test(text)) answeredNow.add('when_started'); const next = options.find(([key]) => !asked.includes(key) && !answeredNow.has(key));
    if (!next) return { understanding: 'The customer has provided the main background information for the tradesperson.', updated_facts: facts, missing_important_information: [], next_action: 'complete', question: null, request_photo: false, request_video: false, safety_flag: false, confidence: 'medium', ready_for_owner: true };
    return { understanding: `The customer reports: ${context.customerMessage}`, updated_facts: facts, missing_important_information: [next[0]], next_action: 'ask_question', question: next[1], request_photo: false, request_video: false, safety_flag: false, confidence: 'medium', ready_for_owner: false };
  }
}
