import { checkPassword, PREFIX_LENGTH, type PasswordVerdict } from '@okolos/core-credential'
import { request, type RequestDeps } from '@okolos/net'

/**
 * The password check, wired to the one place that may reach the network.
 *
 * Everything about the privacy claim is visible here: the local list is
 * consulted first and short-circuits the request entirely; what would be sent
 * is described to the audit log as `hash-prefix:XXXXX` before the request is
 * made; and `Add-Padding` asks the server to return a constant-size response,
 * so an observer counting bytes learns nothing about how many suffixes shared
 * the prefix.
 */

const RANGE_URL = 'https://api.pwnedpasswords.com/range/'

/**
 * The most common passwords, as SHA-1 digests.
 *
 * Deliberately short. This is not a copy of a breach corpus — it is the handful
 * that appear at the top of every one of them, kept small enough to read and to
 * ship. Its only job is to answer the worst cases without a request.
 */
export const COMMON_SHA1: readonly string[] = [
  '7C4A8D09CA3762AF61E59520943DC26494F8941B', // 123456
  'F7C3BC1D808E04732ADF679965CCC34CA7AE3441', // 123456789
  '5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8', // password
  'B1B3773A05C0ED0176787A4F1574FF0075F7521E', // qwerty
  '7C222FB2927D828AF22F592134E8932480637C0D', // 12345678
  '3D4F2BF07DC1BE38B20CD6E46949A1071F9D0E3D', // 111111
  '8CB2237D0679CA88DB6464EAC60DA96345513964', // 12345
  '20EABE5D64B0E216796E834F52D61FD0B70332FC', // 1234567
  '601F1889667EFAEBB33B8C12572835DA3F027F78', // 123123
  '01B307ACBA4F54F55AAFC33BB06BBBF6CA803E9A', // 1234567890
  'C984AED014AEC7623A54F0591DA07A85FD4B762D', // 000000
  '6367C48DD193D56EA7B0BAAD25B19455E529F5EE', // abc123
  '5CEC175B165E3D5E62C9E13CE848EF6FEAC81BFF', // qwerty123
  'EE8D8728F435FD550F83852AABAB5234CE1DA528', // iloveyou
  '48EFC4851E15940AF5D477D3C0CE99211A70A3BE', // 1q2w3e4r
  'D033E22AE348AEB5660FC2140AEC35850C4DA997', // admin
  'B7A875FC1EA228B9061041B7CEC4BD3C52AB3CE3', // letmein
  'C0B137FE2D792459F26FF763CCE44574A5B5AB03', // welcome
  'AB87D24BDC7452E55738DEB5F868E1F16DEA5ACE', // monkey
  'E38AD214943DAAD1D64C102FAEC29DE4AFE9DA3D', // password1
  'AF8978B1797B72ACFFF9595A5A2A373EC3D9106D', // dragon
  '8D6E34F987851AA599257D3831A1AF040886842F', // sunshine
  '775BB961B81DA1CA49217A48E533C832C337154A', // princess
  '2D27B62C597EC858F6E7B54E7E58525E6A95E6D8', // football
  'D8CD10B920DCBDB5163CA0185E402357BC27C265', // charlie
  '89E89C17F877CA2821B557F633CEC3253B0AA941', // aa123456
  '53E11EB7B24CC39E33733A0FF06640F1B39425EA', // donald
  'B0399D2029F64D445BD131FFAA399A42D2F8E7DC', // qwertyuiop
  '7110EDA4D09E062AA5E4A390B0A572AC0D2C0220', // 1234
  '4D9012B4A77A9524D675DAD27C3276AB5705E5E8', // 123321
  'CBFDAC6008F9CAB4083784CBD1874F76618D2A97', // password123
  'CDF547ED4C64E6994AF35CFCD69C4204C9227A97', // zaq12wsx
  'CB45C671CBC500627EA424EEA5F91996221B5935', // qazwsx
  '18C28604DD31094A8D69DAE60F1BCD347F1AFC5A', // superman
  '5FA339BBBB1EEACED3B52E54F44576AAF0D77D96', // asdfghjkl
  '17B9E1C64588C7FA6419B4D29DC1F4426279BA01', // michael
  '4F26AEAFDB2367620A393C973EDDBE8F8B846EBD', // master
  '2736FAB291F04E69B62D490C3C09361F5B82461A', // login
  'CEDF41FCCB586DC39E1CE34BB482F0AFE557B49F', // 696969
  'ED9D3D832AF899035363A69FD53CD3BE8F71501C', // shadow
  '5C6D9EDC3A951CDA763F650235CFC41A3FC23FE8', // batman
  'E68E11BE8B70E435C65AEF8BA9798FF7775C361E', // trustno1
  'AAF4C61DDCC5E8A2DABEDE0F3B482CD9AEA9434D', // hello
  '7ECFD8F97B4729C6FF0799B0B4D40F870083B461', // freedom
  'D869DB7FE62FB07C25A0403ECAEA55031744B5FB', // whatever
  'C53255317BB11707D0F614696B3CE6F221D0E2F2', // qwe123
  '05FE7461C607C33229772D402505601016A7D0EA', // 123qwe
  '327156AB287C6AA52C8670E13163FC1BF660ADD4', // starwars
  'A2C901C8C6DEA98958C219F6F2D038C44DC5D362', // baseball
]

export interface PasswordDeps extends RequestDeps {
  /** Overridable so a test can run the whole path without a network. */
  readonly fetchRange?: (prefix: string) => Promise<string>
}

export async function checkSubmittedPassword(
  sha1: string,
  deps: PasswordDeps,
): Promise<PasswordVerdict> {
  return checkPassword({
    sha1,
    localSuffixes: (prefix) =>
      COMMON_SHA1.filter((digest) => digest.startsWith(prefix)).map((digest) =>
        digest.slice(PREFIX_LENGTH),
      ),
    fetchRange: async (prefix) => {
      if (deps.fetchRange) return { body: await deps.fetchRange(prefix) }

      const response = await request(
        {
          url: `${RANGE_URL}${prefix}`,
          method: 'GET',
          purpose: 'password-range',
          // What a person reads in the audit log is exactly what was sent.
          payloadShape: `hash-prefix:${prefix}`,
          triggeredBy: 'user:password-check',
          // Constant-size responses: an observer counting bytes learns nothing
          // about how many suffixes shared this prefix.
          headers: { 'Add-Padding': 'true' },
        },
        deps,
      )
      // An error status is an unanswered question, not a range: a 503 or 429 body read as a
      // range said "not in a breach" for any password (found 2026-10-29, certifying N-109).
      // i18n-exempt: carried in the verdict's detail for the journal, never shown as a sentence
      if (!response.ok) throw new Error(`range service answered ${response.status}`)
      return { body: await response.text() }
    },
  })
}
