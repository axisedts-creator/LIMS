TESTS_WRONG — regscreen2.drafts.test.tsx:215-224 expects a quote POST without a patient; the contract forbids that body.
Reasons (round 2):
- contracts/openapi/frontdesk.yaml:689-719: quoteRegistration (POST /v1/frontdesk/registrations/quote) takes RegistrationDraft as its request body.
- contracts/openapi/frontdesk.yaml:5666-5674: RegistrationDraft `required` lists `patient`, centre_id, visit_type, billing_mode, items. A quote with no patient fails with common.validation_failed (frontdesk.yaml:704). So the screen is right not to send it on a blank form. fd-t13.states.test.tsx:49 already pins that.
- The task brief (favourite tests tab, star toggle) asks that a favourite click adds the test to the cart and, through it, to the quote. It does not ask for a quote without a patient.
Change in test (assertion at :223 kept word for word): right after `await form();` at :218, pick the patient the way patientAndCbc does:
  `await u.keyboard('{F2}9841000001'); await u.click(await screen.findByRole('option', { name: /Synthetic Patient One/ }, { timeout: T }));`
Then the tab, the name checks (:219-222) and the quote check (:223 toEqual([ITEM.CBC])) stay as they are. Check that the patient pick does not add CBC to the cart first, so the cart still holds only CBC.
