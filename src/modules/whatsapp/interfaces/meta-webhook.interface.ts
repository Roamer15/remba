export interface MetaWebhookPayload {
  entry?: MetaEntry[];
}

export interface MetaEntry {
  changes?: MetaChange[];
}

export interface MetaChange {
  value?: MetaValue;
}

export interface MetaValue {
  messaging_product?: string;
  metadata?: {
    display_phone_number?: string;
    phone_number_id?: string;
  };
  contacts?: MetaContact[];
  messages?: MetaMessage[];
}

export interface MetaContact {
  profile?: {
    name?: string;
  };
  wa_id?: string;
}

export interface MetaMessage {
  from?: string;
  id?: string;
  timestamp?: string;
  type?:
    | 'text'
    | 'audio'
    | 'image'
    | 'button'
    | 'interactive'
    | 'order'
    | 'system';
  text?: {
    body?: string;
  };
}
