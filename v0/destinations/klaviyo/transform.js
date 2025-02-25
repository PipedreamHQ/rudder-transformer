/* eslint-disable no-nested-ternary */
/* eslint-disable no-underscore-dangle */
/* eslint-disable  array-callback-return */
const get = require("get-value");
const {
  EventType,
  WhiteListedTraits,
  MappedToDestinationKey
} = require("../../../constants");
const {
  CONFIG_CATEGORIES,
  BASE_ENDPOINT,
  MAPPING_CONFIG,
  ecomExclusionKeys,
  ecomEvents,
  eventNameMapping,
  jsonNameMapping
} = require("./config");
const {
  isProfileExist,
  checkForMembersAndSubscribe,
  createCustomerProperties
} = require("./util");
const {
  defaultRequestConfig,
  constructPayload,
  getFieldValueFromMessage,
  defaultPostRequestConfig,
  extractCustomFields,
  toUnixTimestamp,
  removeUndefinedAndNullValues,
  CustomError,
  isEmptyObject,
  addExternalIdToTraits,
  adduserIdFromExternalId,
  defaultPutRequestConfig,
  simpleProcessRouterDest
} = require("../../util");

/**
 * Main Identify request handler func
 * The function is used to create/update new users and also for adding/subscribing
 * members to the list depending on conditons.If listId is there member is added to that list &
 * if subscribe is true member is subscribed to that list else not.
 * DOCS: https://www.klaviyo.com/docs/http-api
 * @param {*} message
 * @param {*} category
 * @param {*} destination
 * @returns
 */
const identifyRequestHandler = async (message, category, destination) => {
  // If listId property is present try to subscribe/member user in list
  if (!destination.Config.publicApiKey || !destination.Config.privateApiKey) {
    if (!destination.Config.publicApiKey) {
      throw new CustomError(
        "Public API Key is a required field for identify events",
        400
      );
    } else {
      throw new CustomError(
        "Private API Key is a required field for identify events",
        400
      );
    }
  }
  const mappedToDestination = get(message, MappedToDestinationKey);
  if (mappedToDestination) {
    addExternalIdToTraits(message);
    adduserIdFromExternalId(message);
  }
  const traitsInfo = getFieldValueFromMessage(message, "traits");
  const response = defaultRequestConfig();
  const personId = await isProfileExist(message, destination);
  let propertyPayload = constructPayload(
    message,
    MAPPING_CONFIG[category.name]
  );
  // Extract other K-V property from traits about user custom properties
  propertyPayload = extractCustomFields(
    message,
    propertyPayload,
    ["traits", "context.traits"],
    WhiteListedTraits
  );
  if (!personId) {
    propertyPayload = removeUndefinedAndNullValues(propertyPayload);
    if (destination.Config?.enforceEmailAsPrimary) {
      delete propertyPayload.$id;
      propertyPayload._id = getFieldValueFromMessage(message, "userId");
    }
    const payload = {
      token: destination.Config.publicApiKey,
      properties: propertyPayload
    };
    response.endpoint = `${BASE_ENDPOINT}${category.apiUrl}`;
    response.method = defaultPostRequestConfig.requestMethod;
    response.headers = {
      "Content-Type": "application/json",
      Accept: "text/html"
    };
    response.body.JSON = removeUndefinedAndNullValues(payload);
  } else {
    response.endpoint = `${BASE_ENDPOINT}/api/v1/person/${personId}`;
    response.method = defaultPutRequestConfig.requestMethod;
    response.headers = {
      Accept: "application/json"
    };
    response.params = removeUndefinedAndNullValues(propertyPayload);
    response.params.api_key = destination.Config.privateApiKey;
  }
  const responseArray = [response];
  responseArray.push(
    ...checkForMembersAndSubscribe(message, traitsInfo, destination)
  );
  return responseArray;
};

// ----------------------
// Main handler func for track request/screen request
// User info needs to be mapped to a track event (mandatory)
// DOCS: https://www.klaviyo.com/docs/http-api
// ----------------------

const trackRequestHandler = (message, category, destination) => {
  let payload = {};
  if (!destination.Config.publicApiKey) {
    throw new CustomError(
      "Public API Key is a required field for track events",
      400
    );
  }
  let event = get(message, "event");
  event = event ? event.trim().toLowerCase() : event;
  if (ecomEvents.includes(event) && message.properties) {
    const eventName = eventNameMapping[event];
    payload.event = eventName;
    payload.token = destination.Config.publicApiKey;
    const eventMap = jsonNameMapping[eventName];
    // using identify to create customer properties
    payload.customer_properties = createCustomerProperties(message);
    if (
      !payload.customer_properties.$email &&
      !payload.customer_properties.$phone_number
    ) {
      throw new CustomError(
        "email or phone is required for customer_properties",
        400
      );
    }
    const categ = CONFIG_CATEGORIES[eventMap];
    payload.properties = constructPayload(
      message.properties,
      MAPPING_CONFIG[categ.name]
    );

    // products mapping using Items.json
    // mapping properties.items to payload.properties.items and using properties.products as a fallback to properties.items
    // properties.items is to be deprecated soon
    if (message.properties?.products || message.properties?.items) {
      const items = message.properties.items || message.properties.products;
      const itemArr = [];
      if (Array.isArray(items)) {
        items.forEach(key => {
          let item = constructPayload(
            key,
            MAPPING_CONFIG[CONFIG_CATEGORIES.ITEMS.name]
          );
          item = removeUndefinedAndNullValues(item);
          if (!isEmptyObject(item)) {
            itemArr.push(item);
          }
        });
      }
      if (!payload.properties) {
        payload.properties = {};
      }
      if (itemArr.length > 0) {
        payload.properties.items = itemArr;
      }
    }

    // all extra props passed is incorporated inside properties
    let customProperties = {};
    customProperties = extractCustomFields(
      message,
      customProperties,
      ["properties"],
      ecomExclusionKeys
    );
    if (!isEmptyObject(customProperties)) {
      payload.properties = {
        ...payload.properties,
        ...customProperties
      };
    }

    if (isEmptyObject(payload.properties)) {
      delete payload.properties;
    }
  } else {
    payload = constructPayload(message, MAPPING_CONFIG[category.name]);
    payload.token = destination.Config.publicApiKey;
    if (message.properties && message.properties.revenue) {
      payload.properties.$value = message.properties.revenue;
      delete payload.properties.revenue;
    }
    const customerProperties = createCustomerProperties(message);
    if (destination.Config.enforceEmailAsPrimary) {
      delete customerProperties.$id;
      customerProperties._id = getFieldValueFromMessage(message, "userId");
    }
    payload.customer_properties = customerProperties;
  }
  if (message.timestamp) {
    payload.time = toUnixTimestamp(message.timestamp);
  }
  const response = defaultRequestConfig();
  response.endpoint = `${BASE_ENDPOINT}${category.apiUrl}`;
  response.method = defaultPostRequestConfig.requestMethod;
  response.headers = {
    "Content-Type": "application/json",
    Accept: "text/html"
  };
  response.body.JSON = removeUndefinedAndNullValues(payload);
  return response;
};

// ----------------------
// Main handlerfunc for group request
// we will map user to list (subscribe and/or member)
// based on property sent
// DOCS: https://www.klaviyo.com/docs/api/v2/lists
// ----------------------
const groupRequestHandler = (message, category, destination) => {
  if (!destination.Config.privateApiKey) {
    throw new CustomError(
      "Private API Key is a required field for group events",
      400
    );
  }
  let profile = constructPayload(message, MAPPING_CONFIG[category.name]);
  // Extract other K-V property from traits about user custom properties
  const groupWhitelistedTraits = [
    ...WhiteListedTraits,
    ...["consent", "smsConsent", "subscribe"]
  ];
  profile = extractCustomFields(
    message,
    profile,
    ["traits", "context.traits"],
    groupWhitelistedTraits
  );
  profile = removeUndefinedAndNullValues(profile);
  if (destination.Config.enforceEmailAsPrimary) {
    delete profile.$id;
    profile._id = getFieldValueFromMessage(message, "userId");
  }
  const responseArray = [];

  const payload = {
    profiles: [profile]
  };
  const membersResponse = defaultRequestConfig();
  membersResponse.endpoint = `${BASE_ENDPOINT}/api/v2/list/${get(
    message,
    "groupId"
  )}/members`;
  membersResponse.headers = {
    "Content-Type": "application/json"
  };
  membersResponse.body.JSON = payload;
  membersResponse.method = defaultPostRequestConfig.requestMethod;
  membersResponse.params = { api_key: destination.Config.privateApiKey };
  responseArray.push(membersResponse);

  if (get(message.traits, "subscribe") === true) {
    // Adding Consent Info to Profiles
    const subscribeProfile = JSON.parse(JSON.stringify(profile));
    subscribeProfile.sms_consent =
      message.context?.traits.smsConsent || destination.Config.smsConsent;
    subscribeProfile.$consent =
      message.context?.traits.consent || destination.Config.consent;

    const subscribePayload = {
      profiles: [subscribeProfile]
    };
    const subscribeResponse = defaultRequestConfig();
    subscribeResponse.endpoint = `${BASE_ENDPOINT}/api/v2/list/${get(
      message,
      "groupId"
    )}/subscribe`;
    subscribeResponse.headers = {
      "Content-Type": "application/json"
    };
    subscribeResponse.body.JSON = subscribePayload;
    subscribeResponse.method = defaultPostRequestConfig.requestMethod;
    subscribeResponse.params = { api_key: destination.Config.privateApiKey };
    responseArray.push(subscribeResponse);
  }
  return responseArray;
};

// Main event processor using specific handler funcs
const processEvent = async (message, destination) => {
  if (!message.type) {
    throw new CustomError(
      "Message Type is not present. Aborting message.",
      400
    );
  }
  const messageType = message.type.toLowerCase();

  let category;
  let response;
  switch (messageType) {
    case EventType.IDENTIFY:
      category = CONFIG_CATEGORIES.IDENTIFY;
      response = await identifyRequestHandler(message, category, destination);
      break;
    case EventType.SCREEN:
    case EventType.TRACK:
      category = CONFIG_CATEGORIES.TRACK;
      response = trackRequestHandler(message, category, destination);
      break;
    case EventType.GROUP:
      category = CONFIG_CATEGORIES.GROUP;
      response = groupRequestHandler(message, category, destination);
      break;
    default:
      throw new CustomError("Message type not supported", 400);
  }
  return response;
};

const process = async event => {
  const result = await processEvent(event.message, event.destination);
  return result;
};

const processRouterDest = async inputs => {
  const respList = await simpleProcessRouterDest(inputs, "KLAVIYO", process);
  return respList;
};

module.exports = { process, processRouterDest };
