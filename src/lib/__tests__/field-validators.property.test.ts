/**
 * Property-based tests for field validators.
 *
 * Feature: infra-robustness
 * Properties 9, 10, 11, 12
 *
 * **Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  validateRdsFields,
  validateS3Fields,
  validateIamRoleFields,
} from "../field-validators";

/* ------------------------------------------------------------------ */
/*  Generators                                                         */
/* ------------------------------------------------------------------ */

const lowerAlphaNum = "abcdefghijklmnopqrstuvwxyz0123456789".split("");
const lowerAlpha = "abcdefghijklmnopqrstuvwxyz".split("");
const lowerAlphaNumHyphen = "abcdefghijklmnopqrstuvwxyz0123456789-".split("");
const s3Chars = "abcdefghijklmnopqrstuvwxyz0123456789-.".split("");

/** Helper: generate a string from a character set with given length constraints */
function strFromChars(chars: string[], min: number, max: number) {
  return fc
    .array(fc.constantFrom(...chars), { minLength: min, maxLength: max })
    .map((arr) => arr.join(""));
}

/** Valid RDS identifier: doesn't start/end with hyphen, max 63 chars */
const validRdsIdentifierArb = fc
  .tuple(
    strFromChars(lowerAlphaNum, 1, 5),
    strFromChars(lowerAlphaNumHyphen, 0, 50),
    strFromChars(lowerAlphaNum, 1, 5)
  )
  .map(([start, middle, end]) => start + middle + end)
  .filter((s) => s.length <= 63 && s.length >= 1);

/** RDS identifier that starts with a hyphen */
const rdsStartsWithHyphenArb = strFromChars(lowerAlphaNum, 1, 20).map(
  (s) => "-" + s
);

/** RDS identifier that ends with a hyphen */
const rdsEndsWithHyphenArb = strFromChars(lowerAlphaNum, 1, 20).map(
  (s) => s + "-"
);

/** RDS identifier exceeding 63 chars */
const rdsExceeds63Arb = strFromChars(lowerAlphaNum, 64, 100);

/** Valid S3 bucket name: 3-63 chars, lowercase+numbers+hyphens+periods, no "aws"/"amazon" */
const validS3NameArb = strFromChars(s3Chars, 3, 63).filter(
  (s) => !/aws/i.test(s) && !/amazon/i.test(s)
);

/** S3 name containing "aws" (case-insensitive) */
const s3ContainsAwsArb = fc
  .tuple(
    strFromChars(s3Chars, 0, 20),
    fc.constantFrom("aws", "Aws", "AWS", "aWs"),
    strFromChars(s3Chars, 0, 20)
  )
  .map(([pre, aws, post]) => pre + aws + post)
  .filter((s) => s.length >= 3 && s.length <= 63);

/** S3 name containing "amazon" (case-insensitive) */
const s3ContainsAmazonArb = fc
  .tuple(
    strFromChars(s3Chars, 0, 15),
    fc.constantFrom("amazon", "Amazon", "AMAZON", "aMaZoN"),
    strFromChars(s3Chars, 0, 15)
  )
  .map(([pre, amazon, post]) => pre + amazon + post)
  .filter((s) => s.length >= 3 && s.length <= 63);

/** S3 name too short (< 3 chars) */
const s3TooShortArb = strFromChars(s3Chars, 1, 2);

/** S3 name too long (> 63 chars) */
const s3TooLongArb = strFromChars(s3Chars, 64, 100);

/** S3 name with invalid characters (uppercase, special chars) */
const s3InvalidCharsArb = fc
  .tuple(
    strFromChars(lowerAlphaNum, 1, 10),
    fc.constantFrom("A", "B", "Z", "_", "@", "!", " ", "#"),
    strFromChars(lowerAlphaNum, 1, 10)
  )
  .map(([pre, invalid, post]) => pre + invalid + post)
  .filter(
    (s) => s.length >= 3 && s.length <= 63 && !/aws/i.test(s) && !/amazon/i.test(s)
  );

/** Valid K8s namespace: starts with letter, lowercase alphanumeric + hyphens, max 63 */
const validNamespaceArb = fc
  .tuple(
    fc.constantFrom(...lowerAlpha),
    strFromChars(lowerAlphaNumHyphen, 0, 50)
  )
  .map(([first, rest]) => first + rest)
  .filter((s) => s.length <= 63);

/** Namespace that doesn't start with a letter */
const namespaceNoLetterStartArb = fc
  .tuple(
    fc.constantFrom(..."0123456789-".split("")),
    strFromChars(lowerAlphaNumHyphen, 1, 20)
  )
  .map(([first, rest]) => first + rest);

/** Namespace with invalid characters (uppercase, special) */
const namespaceInvalidCharsArb = fc
  .tuple(
    fc.constantFrom(...lowerAlpha),
    strFromChars(lowerAlphaNum, 1, 10),
    fc.constantFrom("A", "B", "_", ".", "@", "!"),
    strFromChars(lowerAlphaNum, 0, 10)
  )
  .map(([first, mid, invalid, end]) => first + mid + invalid + end)
  .filter((s) => s.length <= 63);

/** Namespace exceeding 63 chars */
const namespaceExceeds63Arb = fc
  .tuple(
    fc.constantFrom(...lowerAlpha),
    strFromChars(lowerAlphaNumHyphen, 63, 100)
  )
  .map(([first, rest]) => first + rest)
  .filter((s) => s.length > 63);

/* ------------------------------------------------------------------ */
/*  Property 9: RDS identifier validation                              */
/*  **Validates: Requirements 6.1**                                    */
/* ------------------------------------------------------------------ */

test("Property 9: valid RDS identifiers are accepted", () => {
  fc.assert(
    fc.property(validRdsIdentifierArb, (identifier) => {
      const result = validateRdsFields({ identifier });
      assert.equal(result, null, `Should accept valid identifier "${identifier}"`);
    }),
    { numRuns: 100 }
  );
});

test("Property 9: RDS identifiers starting with hyphen are rejected", () => {
  fc.assert(
    fc.property(rdsStartsWithHyphenArb, (identifier) => {
      const result = validateRdsFields({ identifier });
      assert.notEqual(
        result,
        null,
        `Should reject identifier starting with hyphen: "${identifier}"`
      );
    }),
    { numRuns: 100 }
  );
});

test("Property 9: RDS identifiers ending with hyphen are rejected", () => {
  fc.assert(
    fc.property(rdsEndsWithHyphenArb, (identifier) => {
      const result = validateRdsFields({ identifier });
      assert.notEqual(
        result,
        null,
        `Should reject identifier ending with hyphen: "${identifier}"`
      );
    }),
    { numRuns: 100 }
  );
});

test("Property 9: RDS identifiers exceeding 63 chars are rejected", () => {
  fc.assert(
    fc.property(rdsExceeds63Arb, (identifier) => {
      const result = validateRdsFields({ identifier });
      assert.notEqual(
        result,
        null,
        `Should reject identifier exceeding 63 chars (length: ${identifier.length})`
      );
    }),
    { numRuns: 100 }
  );
});

/* ------------------------------------------------------------------ */
/*  Property 10: S3 bucket name validation                             */
/*  **Validates: Requirements 6.2, 6.3**                               */
/* ------------------------------------------------------------------ */

test("Property 10: valid S3 bucket names are accepted", () => {
  fc.assert(
    fc.property(validS3NameArb, (bucketName) => {
      const result = validateS3Fields({ bucketName });
      assert.equal(result, null, `Should accept valid bucket name "${bucketName}"`);
    }),
    { numRuns: 100 }
  );
});

test("Property 10: S3 names containing 'aws' are rejected", () => {
  fc.assert(
    fc.property(s3ContainsAwsArb, (bucketName) => {
      const result = validateS3Fields({ bucketName });
      assert.notEqual(
        result,
        null,
        `Should reject bucket name containing 'aws': "${bucketName}"`
      );
    }),
    { numRuns: 100 }
  );
});

test("Property 10: S3 names containing 'amazon' are rejected", () => {
  fc.assert(
    fc.property(s3ContainsAmazonArb, (bucketName) => {
      const result = validateS3Fields({ bucketName });
      assert.notEqual(
        result,
        null,
        `Should reject bucket name containing 'amazon': "${bucketName}"`
      );
    }),
    { numRuns: 100 }
  );
});

test("Property 10: S3 names shorter than 3 chars are rejected", () => {
  fc.assert(
    fc.property(s3TooShortArb, (bucketName) => {
      const result = validateS3Fields({ bucketName });
      assert.notEqual(
        result,
        null,
        `Should reject bucket name shorter than 3 chars: "${bucketName}"`
      );
    }),
    { numRuns: 100 }
  );
});

test("Property 10: S3 names longer than 63 chars are rejected", () => {
  fc.assert(
    fc.property(s3TooLongArb, (bucketName) => {
      const result = validateS3Fields({ bucketName });
      assert.notEqual(
        result,
        null,
        `Should reject bucket name longer than 63 chars (length: ${bucketName.length})`
      );
    }),
    { numRuns: 100 }
  );
});

test("Property 10: S3 names with invalid characters are rejected", () => {
  fc.assert(
    fc.property(s3InvalidCharsArb, (bucketName) => {
      const result = validateS3Fields({ bucketName });
      assert.notEqual(
        result,
        null,
        `Should reject bucket name with invalid chars: "${bucketName}"`
      );
    }),
    { numRuns: 100 }
  );
});

/* ------------------------------------------------------------------ */
/*  Property 11: Kubernetes namespace validation                       */
/*  **Validates: Requirements 6.4**                                    */
/* ------------------------------------------------------------------ */

test("Property 11: valid K8s namespaces are accepted", () => {
  fc.assert(
    fc.property(validNamespaceArb, (namespace) => {
      const result = validateIamRoleFields({ namespace });
      assert.equal(result, null, `Should accept valid namespace "${namespace}"`);
    }),
    { numRuns: 100 }
  );
});

test("Property 11: namespaces not starting with a letter are rejected", () => {
  fc.assert(
    fc.property(namespaceNoLetterStartArb, (namespace) => {
      const result = validateIamRoleFields({ namespace });
      assert.notEqual(
        result,
        null,
        `Should reject namespace not starting with letter: "${namespace}"`
      );
    }),
    { numRuns: 100 }
  );
});

test("Property 11: namespaces with invalid characters are rejected", () => {
  fc.assert(
    fc.property(namespaceInvalidCharsArb, (namespace) => {
      const result = validateIamRoleFields({ namespace });
      assert.notEqual(
        result,
        null,
        `Should reject namespace with invalid chars: "${namespace}"`
      );
    }),
    { numRuns: 100 }
  );
});

test("Property 11: namespaces exceeding 63 chars are rejected", () => {
  fc.assert(
    fc.property(namespaceExceeds63Arb, (namespace) => {
      const result = validateIamRoleFields({ namespace });
      assert.notEqual(
        result,
        null,
        `Should reject namespace exceeding 63 chars (length: ${namespace.length})`
      );
    }),
    { numRuns: 100 }
  );
});

/* ------------------------------------------------------------------ */
/*  Property 12: Field validation error response format                */
/*  **Validates: Requirements 6.5**                                    */
/* ------------------------------------------------------------------ */

test("Property 12: RDS error messages contain field name and rule description", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("identifier", "dbIdentifier", "name"),
      fc.oneof(rdsStartsWithHyphenArb, rdsEndsWithHyphenArb, rdsExceeds63Arb),
      (fieldName, value) => {
        const result = validateRdsFields({ [fieldName]: value });
        if (result !== null) {
          assert.ok(
            result.includes(fieldName),
            `Error message should contain field name "${fieldName}": got "${result}"`
          );
          const hasRuleDescription =
            result.includes("hyphen") ||
            result.includes("63 characters") ||
            result.includes("exceed");
          assert.ok(
            hasRuleDescription,
            `Error message should describe the violated rule: got "${result}"`
          );
        }
      }
    ),
    { numRuns: 100 }
  );
});

test("Property 12: S3 error messages contain field name and rule description", () => {
  fc.assert(
    fc.property(
      fc.oneof(
        s3ContainsAwsArb,
        s3ContainsAmazonArb,
        s3TooShortArb,
        s3TooLongArb,
        s3InvalidCharsArb
      ),
      (bucketName) => {
        const result = validateS3Fields({ bucketName });
        if (result !== null) {
          assert.ok(
            result.includes("bucketName"),
            `Error message should contain field name "bucketName": got "${result}"`
          );
          const hasRuleDescription =
            result.includes("aws") ||
            result.includes("amazon") ||
            result.includes("characters") ||
            result.includes("lowercase") ||
            result.includes("3 characters") ||
            result.includes("63 characters") ||
            result.includes("exceed");
          assert.ok(
            hasRuleDescription,
            `Error message should describe the violated rule: got "${result}"`
          );
        }
      }
    ),
    { numRuns: 100 }
  );
});

test("Property 12: IAM role error messages contain field name and rule description", () => {
  fc.assert(
    fc.property(
      fc.oneof(
        namespaceNoLetterStartArb,
        namespaceInvalidCharsArb,
        namespaceExceeds63Arb
      ),
      (namespace) => {
        const result = validateIamRoleFields({ namespace });
        if (result !== null) {
          assert.ok(
            result.includes("namespace"),
            `Error message should contain field name "namespace": got "${result}"`
          );
          const hasRuleDescription =
            result.includes("letter") ||
            result.includes("lowercase") ||
            result.includes("alphanumeric") ||
            result.includes("63 characters") ||
            result.includes("exceed") ||
            result.includes("hyphens");
          assert.ok(
            hasRuleDescription,
            `Error message should describe the violated rule: got "${result}"`
          );
        }
      }
    ),
    { numRuns: 100 }
  );
});
