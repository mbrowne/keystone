/**
 * Converts the first character of a string to uppercase.
 * @param {String} str The string to convert.
 * @returns The new string
 */
export const upcase = (str: string) => str.substr(0, 1).toUpperCase() + str.substr(1);

/**
 * Converts the first character of a string to lowercase.
 * @param {String} str The string to convert.
 * @returns The new string
 */
export const lowcase = (str: string) => str.substr(0, 1).toLowerCase() + str.substr(1);

/**
 * Turns a passed in string into
 * a human readable label
 * @param {String} str The string to convert.
 * @returns The new string
 */
export const humanize = (str: string) => {
  return str
    .replace(/([a-z])([A-Z]+)/g, '$1 $2')
    .split(/\s|_|\-/)
    .filter(i => i)
    .map(upcase)
    .join(' ');
};
