/* eslint-disable no-underscore-dangle */
import getLogger from 'debug';
import { ElementCompact } from 'xml-js';

import { collectionQuery, supportedReportSet } from './collection';
import { DAVNamespace, DAVNamespaceShort } from './consts';
import { createObject, deleteObject, propfind, updateObject } from './request';
import { DAVDepth, DAVResponse } from './types/DAVTypes';
import { DAVAccount, DAVAddressBook, DAVVCard } from './types/models';
import { excludeHeaders, getDAVAttribute } from './util/requestHelpers';
import { findMissingFieldNames, hasFields } from './util/typeHelpers';

const debug = getLogger('tsdav:addressBook');

export const addressBookQuery = async (params: {
  url: string;
  props: ElementCompact;
  filters?: ElementCompact;
  depth?: DAVDepth;
  headers?: Record<string, string>;
  headersToExclude?: string[];
  fetchOptions?: RequestInit;
}): Promise<DAVResponse[]> => {
  const { url, props, filters, depth, headers, headersToExclude, fetchOptions = {}, } = params;
  return collectionQuery({
    url,
    body: {
      'addressbook-query': {
        _attributes: getDAVAttribute([DAVNamespace.CARDDAV, DAVNamespace.DAV]),
        [`${DAVNamespaceShort.DAV}:prop`]: props,
        filter: filters ?? {
          'prop-filter': {
            _attributes: {
              name: 'FN',
            },
          },
        },
      },
    },
    defaultNamespace: DAVNamespaceShort.CARDDAV,
    depth,
    headers: excludeHeaders(headers, headersToExclude),
    fetchOptions
  });
};

export const addressBookMultiGet = async (params: {
  url: string;
  props: ElementCompact;
  objectUrls: string[];
  depth: DAVDepth;
  headers?: Record<string, string>;
  headersToExclude?: string[];
  fetchOptions?: RequestInit;
}): Promise<DAVResponse[]> => {
  const { url, props, objectUrls, depth, headers, headersToExclude, fetchOptions = {}, } = params;
  return collectionQuery({
    url,
    body: {
      'addressbook-multiget': {
        _attributes: getDAVAttribute([DAVNamespace.DAV, DAVNamespace.CARDDAV]),
        [`${DAVNamespaceShort.DAV}:prop`]: props,
        [`${DAVNamespaceShort.DAV}:href`]: objectUrls,
      },
    },
    defaultNamespace: DAVNamespaceShort.CARDDAV,
    depth,
    headers: excludeHeaders(headers, headersToExclude),
    fetchOptions,
  });
};

export const fetchAddressBooks = async (params?: {
  account?: DAVAccount;
  props?: ElementCompact;
  headers?: Record<string, string>;
  headersToExclude?: string[];
  fetchOptions?: RequestInit;
}): Promise<DAVAddressBook[]> => {
  const { account, headers, props: customProps, headersToExclude, fetchOptions = {} } = params ?? {};
  const requiredFields: Array<keyof DAVAccount> = ['homeUrl', 'rootUrl'];
  if (!account || !hasFields(account, requiredFields)) {
    if (!account) {
      throw new Error('no account for fetchAddressBooks');
    }
    throw new Error(
      `account must have ${findMissingFieldNames(
        account,
        requiredFields,
      )} before fetchAddressBooks`,
    );
  }
  const res = await propfind({
    url: account.homeUrl,
    props: customProps ?? {
      [`${DAVNamespaceShort.DAV}:displayname`]: {},
      [`${DAVNamespaceShort.CALENDAR_SERVER}:getctag`]: {},
      [`${DAVNamespaceShort.DAV}:resourcetype`]: {},
      [`${DAVNamespaceShort.DAV}:sync-token`]: {},
    },
    depth: '1',
    headers: excludeHeaders(headers, headersToExclude),
    fetchOptions,
  });
  return Promise.all(
    res
      .filter((r) => Object.keys(r.props?.resourcetype ?? {}).includes('addressbook'))
      .map((rs) => {
        const displayName = rs.props?.displayname?._cdata ?? rs.props?.displayname;
        debug(`Found address book named ${typeof displayName === 'string' ? displayName : ''},
             props: ${JSON.stringify(rs.props)}`);
        return {
          url: new URL(rs.href ?? '', account.rootUrl ?? '').href,
          ctag: rs.props?.getctag,
          displayName: typeof displayName === 'string' ? displayName : '',
          resourcetype: Object.keys(rs.props?.resourcetype),
          syncToken: rs.props?.syncToken,
        };
      })
      .map(async (addr) => ({
        ...addr,
        reports: await supportedReportSet({ collection: addr, headers: excludeHeaders(headers, headersToExclude), fetchOptions }),
      })),
  );
};

export const fetchVCards = async (params: {
  addressBook: DAVAddressBook;
  headers?: Record<string, string>;
  objectUrls?: string[];
  urlFilter?: (url: string) => boolean;
  useMultiGet?: boolean;
  headersToExclude?: string[];
  fetchOptions?: RequestInit;
}): Promise<DAVVCard[]> => {
  const {
    addressBook,
    headers,
    objectUrls,
    headersToExclude,
    urlFilter = (url) => url,
    useMultiGet = true,
    fetchOptions = {}
  } = params;
  debug(`Fetching vcards from ${addressBook?.url}`);
  const requiredFields: Array<'url'> = ['url'];
  if (!addressBook || !hasFields(addressBook, requiredFields)) {
    if (!addressBook) {
      throw new Error('cannot fetchVCards for undefined addressBook');
    }
    throw new Error(
      `addressBook must have ${findMissingFieldNames(
        addressBook,
        requiredFields,
      )} before fetchVCards`,
    );
  }

  const vcardUrls = (
    objectUrls ??
    // fetch all objects of the calendar
    (
      await addressBookQuery({
        url: addressBook.url,
        props: { [`${DAVNamespaceShort.DAV}:getetag`]: {} },
        depth: '1',
        headers: excludeHeaders(headers, headersToExclude),
        fetchOptions,
      })
    ).map((res) => (res.ok ? res.href ?? '' : ''))
  )
    .map((url) => (url.startsWith('http') || !url ? url : new URL(url, addressBook.url).href))
    .filter(urlFilter)
    .map((url) => new URL(url).pathname);

  let vCardResults: DAVResponse[] = [];
  if (vcardUrls.length > 0) {
    if (useMultiGet) {
      vCardResults = await addressBookMultiGet({
        url: addressBook.url,
        props: {
          [`${DAVNamespaceShort.DAV}:getetag`]: {},
          [`${DAVNamespaceShort.CARDDAV}:address-data`]: {},
        },
        objectUrls: vcardUrls,
        depth: '1',
        headers: excludeHeaders(headers, headersToExclude),
        fetchOptions
      });
    } else {
      vCardResults = await addressBookQuery({
        url: addressBook.url,
        props: {
          [`${DAVNamespaceShort.DAV}:getetag`]: {},
          [`${DAVNamespaceShort.CARDDAV}:address-data`]: {},
        },
        depth: '1',
        headers: excludeHeaders(headers, headersToExclude),
        fetchOptions
      });
    }
  }

  return vCardResults.map((res) => ({
    url: new URL(res.href ?? '', addressBook.url).href,
    etag: res.props?.getetag,
    data: res.props?.addressData?._cdata ?? res.props?.addressData,
  }));
};

export const createVCard = async (params: {
  addressBook: DAVAddressBook;
  vCardString: string;
  filename: string;
  headers?: Record<string, string>;
  headersToExclude?: string[];
  fetchOptions?: RequestInit;
}): Promise<Response> => {
  const { addressBook, vCardString, filename, headers, headersToExclude, fetchOptions = {} } = params;
  return createObject({
    url: new URL(filename, addressBook.url).href,
    data: vCardString,
    headers: excludeHeaders(
      {
        'content-type': 'text/vcard; charset=utf-8',
        'If-None-Match': '*',
        ...headers,
      },
      headersToExclude,
    ),
    fetchOptions
  });
};

export const updateVCard = async (params: {
  vCard: DAVVCard;
  headers?: Record<string, string>;
  headersToExclude?: string[];
  fetchOptions?: RequestInit;
}): Promise<Response> => {
  const { vCard, headers, headersToExclude, fetchOptions = {} } = params;
  return updateObject({
    url: vCard.url,
    data: vCard.data,
    etag: vCard.etag,
    headers: excludeHeaders(
      {
        'content-type': 'text/vcard; charset=utf-8',
        ...headers,
      },
      headersToExclude,
    ),
    fetchOptions,
  });
};

export const deleteVCard = async (params: {
  vCard: DAVVCard;
  headers?: Record<string, string>;
  headersToExclude?: string[];
  fetchOptions?: RequestInit;
}): Promise<Response> => {
  const { vCard, headers, headersToExclude, fetchOptions = {} } = params;
  return deleteObject({
    url: vCard.url,
    etag: vCard.etag,
    headers: excludeHeaders(headers, headersToExclude),
    fetchOptions
  });
};
