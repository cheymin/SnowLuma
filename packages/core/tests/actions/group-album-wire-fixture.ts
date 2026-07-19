import type { pb } from '@snowluma/proton';

interface GroupAlbumMediaListReqInfoWireOracle {
  reserved?: pb<4, string>;
  pageInfo?: pb<5, string>;
}

export interface GroupAlbumMediaListRequestWireOracle {
  reqInfo?: pb<4, GroupAlbumMediaListReqInfoWireOracle>;
}
