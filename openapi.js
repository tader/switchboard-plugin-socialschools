import manifest from './plugin.json' with { type: 'json' };

const id = { type: 'integer', minimum: 1 };
const text = { type: 'string' };
const date = { type: 'string', format: 'date-time' };
const object = properties => ({ type: 'object', properties, additionalProperties: true });
const list = items => ({ type: 'array', items });
const page = items => object({ values: list(items), totalCount: { type: 'integer' }, timeStamp: date, nextUrl: { type: 'string', nullable: true }, nextSince: text });
const query = (name, schema = text, description, required = false) => ({ name, in: 'query', required, schema, ...(description ? { description } : {}) });
const path = (name, schema = id) => ({ name, in: 'path', required: true, schema });
const paging = [query('offset', { type: 'integer', minimum: 0, default: 0 }), query('limit', { type: 'integer', minimum: 1, default: 20 }), query('timeStamp', date, 'Reuse the list response timeStamp while paging.')];
const person = object({ id, roleType: id, uniqueId: id, displayName: text });
const community = object({ id, groupId: id, name: text });
const message = object({ id: text, body: text, created: date, createdBy: person, media: list(object({ id: text, fileName: text, fullPath: text })) });
const topic = object({ id: text, title: text, participants: list(person), latestMessage: message, unseenCount: { type: 'integer' }, permissions: object({ write: { type: 'boolean' } }) });
const post = object({ id, title: text, body: text, created: date, communities: list(community), author: person, commentsCount: { type: 'integer' }, media: list(object({ fileName: text, fullPath: text })) });
const event = object({ id, title: text, description: text, start: date, end: date, allDay: { type: 'boolean' }, location: text, communities: list(community) });
const slot = object({ id, blockId: id, start: date, end: date, status: { type: 'integer', enum: [0, 1, 2, 3], description: '0 open, 1 break, 2 blocked, 3 assigned.' }, timestamp: text, meetingId: { ...id, nullable: true }, available: { type: 'boolean' }, hasReservation: { type: 'boolean' }, locked: { type: 'boolean' } });
const meetingSet = object({ id, title: text, description: text, registerStart: date, registerEnd: { ...date, nullable: true }, blocks: list(object({ id, timeslots: list(slot) })), meetings: list(object({ id, studentId: id, parentIds: list(id), meetingLocationType: { type: 'integer' }, videoMeeting: { type: 'object', nullable: true } })) });
const paths = {};
function operation(method, url, operationId, summary, tag, schema, parameters = [], body, description) {
  (paths[url] ??= {})[method] = {
    operationId, summary, tags: [tag], ...(description ? { description } : {}),
    parameters, responses: { 200: { description: 'Success', content: { 'application/json': { schema } } } },
    ...(body ? { requestBody: { required: true, content: { 'application/json': { schema: body } } } } : {}),
  };
}
operation('get', '/useraccounts/current', 'getCurrentAccount', 'Get account, school roles, and connected children', 'Account', object({ userProfileId: id, displayName: text, roles: list(object({ id, type: id, school: object({ id, name: text }), connections: list(person) })) }));
operation('get', '/communities', 'listGroups', 'List school and class groups', 'Account', page(community), [query('showAll', { type: 'boolean', default: true })]);
operation('get', '/communityposts', 'listAnnouncements', 'List announcements', 'Announcements', page(post), [...paging, query('filterType', { type: 'integer', default: 0 }, '0 is the normal feed.' )]);
operation('get', '/communityposts/{postId}', 'getAnnouncement', 'Get an announcement', 'Announcements', post, [path('postId')]);
operation('get', '/events', 'listEvents', 'List calendar events in a date range', 'Calendar', list(event), [query('from', date, 'Inclusive range start.', true), query('until', date, 'Range end.', true)]);
operation('get', '/events/{eventId}', 'getEvent', 'Get a calendar event', 'Calendar', event, [path('eventId')]);
operation('get', '/inboxes', 'listInboxes', 'List available conversation inboxes', 'Conversations', page(person));
operation('get', '/recipients', 'listRecipients', 'Find teachers and other available conversation recipients', 'Conversations', page(person), [...paging, query('inboxId', id, 'Inbox returned by listInboxes.', true), query('connectionRoleType', { type: 'integer', enum: [1, 2, 3], default: 2 }, '1 parents, 2 employees, 3 students.'), query('q', text, 'Search text.')]);
const inbox = [path('inboxId')];
const thread = [...inbox, path('topicId', { type: 'string', format: 'uuid' })];
operation('get', '/inboxes/{inboxId}/topics', 'listConversations', 'List inbox conversations', 'Conversations', page(topic), [...inbox, ...paging, query('archived', { type: 'boolean' }), query('since', text, 'Incremental cursor returned by Social Schools.')]);
operation('get', '/inboxes/{inboxId}/topics/{topicId}', 'getConversation', 'Get a conversation', 'Conversations', topic, thread);
operation('get', '/inboxes/{inboxId}/topics/{topicId}/messages', 'listMessages', 'Read conversation messages', 'Conversations', page(message), [...thread, ...paging], undefined, 'Social Schools may update read receipts when messages are retrieved. The response may include pagination cursors; follow them on the same API host.');
const messageInput = { ...object({ body: { ...text, minLength: 1 }, media: { ...list(object({})), default: [] }, postMedia: { ...list(object({})), default: [] } }), required: ['body', 'media', 'postMedia'] };
operation('post', '/inboxes/{inboxId}/topics/{topicId}/messages', 'sendMessage', 'Send a message to an existing conversation', 'Conversations', message, thread, messageInput, 'Sends immediately. Requires Allow messages and changes on this connection. Do not retry blindly after a timeout: check the conversation for duplicates.');
operation('post', '/inboxes/{inboxId}/topics', 'startConversation', 'Start a conversation and send its first message', 'Conversations', topic, inbox, {
  ...object({ ...messageInput.properties, title: { ...text, minLength: 1 }, topicType: { type: 'integer', enum: [1], default: 1 }, status: { type: 'integer', enum: [30], default: 30 }, participants: { ...list({ ...object({ id, roleType: id }), required: ['id', 'roleType'] }), minItems: 1 } }),
  required: ['title', 'body', 'topicType', 'status', 'participants', 'media', 'postMedia'],
}, 'Sends immediately. Use recipient role IDs from Social Schools, not profile IDs or email addresses. Write schema verified from the web application; not exercised against a live account.');
operation('get', '/meetings/sets/parents', 'listParentMeetings', 'List parent meeting schedules, slots, and reservations', 'Parent meetings', list(meetingSet), [], undefined, 'Match blocks[].timeslots[].meetingId with meetings[].id, then meetings[].studentId with children from getCurrentAccount. A non-null meetingId identifies a reserved slot.');
operation('put', '/meetings/sets/{setId}/timeslots/{slotId}', 'updateMeetingReservation', 'Book or cancel a parent meeting slot', 'Parent meetings', object({}), [path('setId'), path('slotId')], {
  ...object({ id, blockId: id, start: date, end: date, status: { type: 'integer', enum: [0, 3] }, meetingId: { ...id, nullable: true }, timestamp: text }),
  required: ['id', 'blockId', 'start', 'end', 'status', 'meetingId', 'timestamp'],
}, 'Changes a reservation. Copy the slot fields and current timestamp from listParentMeetings. Book with status=3 and the child meeting ID; cancel with status=0 and meetingId=null. Never change a locked slot. A new booking can replace an existing booking for that child. HTTP 409/410 means the slot changed: re-read the schedule. Location selection may also be required. Schema verified from app code; not live tested.');
operation('put', '/meetings/sets/{setId}/meetings/{meetingId}/meetingLocationType', 'setMeetingLocation', 'Choose in-person or video meeting', 'Parent meetings', object({}), [path('setId'), path('meetingId')], { ...object({ meetingLocationType: { type: 'integer', enum: [1, 2], description: '1 in person, 2 video.' } }), required: ['meetingLocationType'] }, 'Changes the meeting location type. Use when the schedule permits parents to choose. Not live tested.');
export default {
  openapi: '3.0.3', info: { title: 'Social Schools', version: manifest.version, description: 'Unofficial API reference derived from the Social Schools web app. Availability depends on school modules and your role. School and role headers are supplied by Switchboard. Write operations have not been exercised against a live account.' },
  servers: [{ url: 'https://api.socialschools.eu/api/v1' }],
  security: [{ bearer: [] }], components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } }, paths,
};
